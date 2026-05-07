import { z } from "zod";
import { callTool, BlueAgentClientOptions } from "./client";

export interface BlueAgentProviderOptions extends BlueAgentClientOptions {
  // inherits baseUrl, apiKey, signPayment
}

/**
 * Creates a Blue Agent action provider compatible with Coinbase AgentKit's ActionProvider pattern.
 * Provides all 32 x402 tools on Base as AgentKit actions.
 */
export function createBlueAgentProvider(options: BlueAgentProviderOptions = {}) {
  return {
    name: "blueagent",

    supportsNetwork: (_network: unknown) => true,

    getActions: (_walletProvider: unknown) => [
      {
        name: "risk_gate",
        description:
          "Screen a transaction before execution — flags high-risk actions, rug pulls, and malicious contracts on Base. Price: $0.05 USDC.",
        schema: z.object({
          action: z.string().describe("Action to evaluate (e.g. transfer / swap / approve)"),
          contractAddress: z.string().describe("Contract address (0x…)").optional(),
          amount: z.string().describe("Amount involved in the action").optional(),
          toAddress: z.string().describe("Recipient address (0x…)").optional(),
        }),
        invoke: async (args: {
          action: string;
          contractAddress?: string;
          amount?: string;
          toAddress?: string;
        }) => callTool("risk-gate", args as Record<string, unknown>, options),
      },

      {
        name: "honeypot_check",
        description:
          "Detect honeypot tokens — checks if a token can be sold after purchase on Base. Price: $0.10 USDC.",
        schema: z.object({
          token: z.string().describe("Token contract address (0x…)"),
        }),
        invoke: async (args: { token: string }) =>
          callTool("honeypot-check", args as Record<string, unknown>, options),
      },

      {
        name: "allowance_audit",
        description:
          "Audit all active ERC-20 token allowances for a wallet — identifies dangerous unlimited approvals on Base. Price: $0.10 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address to audit (0x…)"),
        }),
        invoke: async (args: { address: string }) =>
          callTool("allowance-audit", args as Record<string, unknown>, options),
      },

      {
        name: "phishing_scan",
        description:
          "Scan a URL, contract address, or social handle for phishing indicators on Base. Price: $0.10 USDC.",
        schema: z.object({
          url: z.string().describe("URL, contract address (0x…), or social handle to scan"),
        }),
        invoke: async (args: { url: string }) =>
          callTool("phishing-scan", args as Record<string, unknown>, options),
      },

      {
        name: "mev_shield",
        description:
          "Analyze a swap for MEV (sandwich attack) risk and suggest safe execution parameters on Base. Price: $0.10 USDC.",
        schema: z.object({
          tokenIn: z.string().describe("Input token address (0x…)"),
          tokenOut: z.string().describe("Output token address (0x…)"),
          amountIn: z.string().describe("Input amount (e.g. 1000)"),
        }),
        invoke: async (args: { tokenIn: string; tokenOut: string; amountIn: string }) =>
          callTool("mev-shield", args as Record<string, unknown>, options),
      },

      {
        name: "contract_trust",
        description:
          "Score a smart contract's trustworthiness — checks verification, ownership, and known vulnerabilities on Base. Price: $0.10 USDC.",
        schema: z.object({
          contractAddress: z.string().describe("Contract address to evaluate (0x…)"),
        }),
        invoke: async (args: { contractAddress: string }) =>
          callTool("contract-trust", args as Record<string, unknown>, options),
      },

      {
        name: "circuit_breaker",
        description:
          "Evaluate whether an agent action should be paused or blocked based on risk rules. Price: $0.10 USDC.",
        schema: z.object({
          agentId: z.string().describe("Agent ID to check (e.g. agent-001)"),
          action: z.string().describe("Action the agent wants to perform").optional(),
        }),
        invoke: async (args: { agentId: string; action?: string }) =>
          callTool("circuit-breaker", args as Record<string, unknown>, options),
      },

      {
        name: "key_exposure",
        description:
          "Check if a wallet address has been flagged for private key exposure or compromise on Base. Price: $0.10 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address to check (0x…)"),
        }),
        invoke: async (args: { address: string }) =>
          callTool("key-exposure", args as Record<string, unknown>, options),
      },

      {
        name: "quantum_premium",
        description:
          "Deep quantum-readiness analysis for a single wallet — full entropy, key strength, and migration report on Base. Price: $1.50 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address to analyze (0x…)"),
        }),
        invoke: async (args: { address: string }) =>
          callTool("quantum-premium", args as Record<string, unknown>, options),
      },

      {
        name: "quantum_batch",
        description:
          "Batch quantum-readiness check for up to 10 wallet addresses at once on Base. Price: $2.50 USDC.",
        schema: z.object({
          addresses: z
            .string()
            .describe("Comma-separated wallet addresses to check (0x…, 0x…, up to 10)"),
        }),
        invoke: async (args: { addresses: string }) =>
          callTool("quantum-batch", args as Record<string, unknown>, options),
      },

      {
        name: "quantum_migrate",
        description:
          "Generate a quantum-safe migration plan for a wallet address on Base. Price: $0.10 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address to migrate (0x…)"),
        }),
        invoke: async (args: { address: string }) =>
          callTool("quantum-migrate", args as Record<string, unknown>, options),
      },

      {
        name: "quantum_timeline",
        description:
          "Get the projected timeline for quantum computing threats to Ethereum wallets on Base. Price: $0.10 USDC.",
        schema: z.object({
          address: z.string().describe("Optional wallet address for personalized timeline (0x…)").optional(),
        }),
        invoke: async (args: { address?: string }) =>
          callTool("quantum-timeline", args as Record<string, unknown>, options),
      },

      {
        name: "deep_analysis",
        description:
          "Comprehensive deep-dive analysis of a token — fundamentals, tokenomics, on-chain activity, and risk score on Base. Price: $0.35 USDC.",
        schema: z.object({
          token: z.string().describe("Token address (0x…) or symbol (e.g. USDC)"),
        }),
        invoke: async (args: { token: string }) =>
          callTool("deep-analysis", args as Record<string, unknown>, options),
      },

      {
        name: "token_launch",
        description:
          "Launch a new token on Base — deploys contract, sets metadata, and lists on DEX. Price: $1.00 USDC.",
        schema: z.object({
          tokenName: z.string().describe("Full token name (e.g. Blue Agent)"),
          tokenSymbol: z.string().describe("Token ticker symbol (e.g. BLUE)"),
          description: z.string().describe("Description of what the token represents"),
          imageUrl: z.string().url().describe("Token image URL (https://…)").optional(),
          twitter: z.string().describe("Twitter/X handle without @").optional(),
          website: z.string().url().describe("Project website URL (https://…)").optional(),
        }),
        invoke: async (args: {
          tokenName: string;
          tokenSymbol: string;
          description: string;
          imageUrl?: string;
          twitter?: string;
          website?: string;
        }) => callTool("token-launch", args as Record<string, unknown>, options),
      },

      {
        name: "launch_advisor",
        description:
          "Get AI-powered launch strategy advice for your project on Base — timing, pricing, and distribution recommendations. Price: $3.00 USDC.",
        schema: z.object({
          projectName: z.string().describe("Project or token name"),
          description: z.string().describe("Brief project description").optional(),
        }),
        invoke: async (args: { projectName: string; description?: string }) =>
          callTool("launch-advisor", args as Record<string, unknown>, options),
      },

      {
        name: "grant_evaluator",
        description:
          "Evaluate a project's eligibility and fit for Base ecosystem grants — scores criteria and suggests improvements. Price: $5.00 USDC.",
        schema: z.object({
          projectUrl: z.string().describe("Project URL or detailed description"),
        }),
        invoke: async (args: { projectUrl: string }) =>
          callTool("grant-evaluator", args as Record<string, unknown>, options),
      },

      {
        name: "x402_readiness",
        description:
          "Audit an API endpoint for x402 payment protocol readiness — checks headers, pricing, and compliance. Price: $0.10 USDC.",
        schema: z.object({
          apiUrl: z.string().url().describe("API URL to audit for x402 readiness (https://…)"),
        }),
        invoke: async (args: { apiUrl: string }) =>
          callTool("x402-readiness", args as Record<string, unknown>, options),
      },

      {
        name: "base_deploy_check",
        description:
          "Verify a deployed contract on Base — checks verification status, constructor args, and deployment integrity. Price: $0.10 USDC.",
        schema: z.object({
          contractAddress: z.string().describe("Deployed contract address on Base (0x…)"),
        }),
        invoke: async (args: { contractAddress: string }) =>
          callTool("base-deploy-check", args as Record<string, unknown>, options),
      },

      {
        name: "tokenomics_score",
        description:
          "Score a token's economic model — supply, distribution, vesting, and long-term sustainability on Base. Price: $0.10 USDC.",
        schema: z.object({
          token: z.string().describe("Token address (0x…) or symbol"),
        }),
        invoke: async (args: { token: string }) =>
          callTool("tokenomics-score", args as Record<string, unknown>, options),
      },

      {
        name: "whitepaper_tldr",
        description:
          "Fetch and summarize a whitepaper or technical document into a concise TL;DR. Price: $0.10 USDC.",
        schema: z.object({
          url: z.string().url().describe("Whitepaper URL (https://…)"),
        }),
        invoke: async (args: { url: string }) =>
          callTool("whitepaper-tldr", args as Record<string, unknown>, options),
      },

      {
        name: "vc_tracker",
        description:
          "Track recent VC investments and funding rounds in a specific sector or for a specific address. Price: $0.10 USDC.",
        schema: z.object({
          sector: z.string().describe("Sector or address to track (e.g. DeFi, AI, 0x…)"),
        }),
        invoke: async (args: { sector: string }) =>
          callTool("vc-tracker", args as Record<string, unknown>, options),
      },

      {
        name: "wallet_pnl",
        description:
          "Calculate realized and unrealized PnL for a wallet across all positions on Base. Price: $1.00 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address to analyze (0x…)"),
        }),
        invoke: async (args: { address: string }) =>
          callTool("wallet-pnl", args as Record<string, unknown>, options),
      },

      {
        name: "whale_tracker",
        description:
          "Track large wallet movements and whale activity for a token on Base. Price: $0.10 USDC.",
        schema: z.object({
          token: z.string().describe("Token contract address to track (0x…)"),
        }),
        invoke: async (args: { token: string }) =>
          callTool("whale-tracker", args as Record<string, unknown>, options),
      },

      {
        name: "aml_screen",
        description:
          "AML (Anti-Money Laundering) screening for a wallet address — checks against sanctions and flagged addresses. Price: $0.10 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address to screen (0x…)"),
        }),
        invoke: async (args: { address: string }) =>
          callTool("aml-screen", args as Record<string, unknown>, options),
      },

      {
        name: "airdrop_check",
        description:
          "Check a wallet's eligibility for active and upcoming airdrops on Base. Price: $0.10 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address to check (0x…)"),
        }),
        invoke: async (args: { address: string }) =>
          callTool("airdrop-check", args as Record<string, unknown>, options),
      },

      {
        name: "narrative_pulse",
        description:
          "Get the current narrative trends and sentiment pulse in crypto — optionally filtered by topic. Price: $0.10 USDC.",
        schema: z.object({
          topic: z
            .string()
            .describe("Optional topic to focus on (e.g. DeFi, AI agents, Base)")
            .optional(),
        }),
        invoke: async (args: { topic?: string }) =>
          callTool("narrative-pulse", args as Record<string, unknown>, options),
      },

      {
        name: "dex_flow",
        description:
          "Analyze DEX trading flow and order book depth for a token on Base. Price: $0.10 USDC.",
        schema: z.object({
          token: z.string().describe("Token address (0x…) or trading pair (e.g. ETH/USDC)"),
        }),
        invoke: async (args: { token: string }) =>
          callTool("dex-flow", args as Record<string, unknown>, options),
      },

      {
        name: "yield_optimizer",
        description:
          "Find the best yield opportunities across Base DeFi protocols for a wallet. Price: $0.10 USDC.",
        schema: z.object({
          address: z
            .string()
            .describe("Optional wallet address for personalized recommendations (0x…)")
            .optional(),
        }),
        invoke: async (args: { address?: string }) =>
          callTool("yield-optimizer", args as Record<string, unknown>, options),
      },

      {
        name: "lp_analyzer",
        description:
          "Analyze liquidity pool positions for a wallet — impermanent loss, fees earned, and rebalancing suggestions on Base. Price: $0.10 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address with LP positions (0x…)"),
        }),
        invoke: async (args: { address: string }) =>
          callTool("lp-analyzer", args as Record<string, unknown>, options),
      },

      {
        name: "tax_report",
        description:
          "Generate a tax report for a wallet address for a specific year — tracks taxable events on Base. Price: $0.10 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address (0x…)"),
          year: z.coerce.number().describe("Tax year (e.g. 2024)"),
        }),
        invoke: async (args: { address: string; year: number }) =>
          callTool("tax-report", args as Record<string, unknown>, options),
      },

      {
        name: "alert_subscribe",
        description:
          "Subscribe to real-time on-chain alerts for a wallet address — sends notifications to a webhook URL. Price: $0.10 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address to monitor (0x…)"),
          webhookUrl: z.string().url().describe("Webhook URL to receive alerts (https://…)"),
        }),
        invoke: async (args: { address: string; webhookUrl: string }) =>
          callTool("alert-subscribe", args as Record<string, unknown>, options),
      },

      {
        name: "alert_check",
        description:
          "Check the status of active alerts for a wallet address. Price: $0.10 USDC.",
        schema: z.object({
          address: z.string().describe("Wallet address to check alerts for (0x…)"),
        }),
        invoke: async (args: { address: string }) =>
          callTool("alert-check", args as Record<string, unknown>, options),
      },
    ],
  };
}
