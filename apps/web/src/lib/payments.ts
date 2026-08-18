import { getAddress } from "viem";

/**
 * Single source of truth for the chat-credit top-up feature ("Pay with USDC").
 *
 * Both legs import from here so the constants can't drift:
 *   - client  → components/TopUpModal.tsx  (builds the USDC transfer)
 *   - server  → app/api/credits/purchase/route.ts  (verifies + credits)
 *
 * Non-custodial: the user signs a direct USDC transfer from their own wallet to
 * the Blue treasury; the server only READS the settled transaction and credits
 * the off-chain ledger. Nothing here ever holds a key or moves funds itself.
 */

// USDC on Base (6 decimals) — canonical, verified on Basescan.
export const USDC_BASE = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

// payTo — the Blue Agent treasury. As of 2026-08-18 this is the SINGLE payee
// for every surface: chat-credit top-ups AND x402 tool calls (agent-tools'
// BLUE_TREASURY, x402-cdp's PAY_TO). It used to be deliberately decoupled from
// the old 0xb058… Bankr payout wallet; that wallet is retired, so the two were
// unified onto this address. Still kept as a local const so this feature
// doesn't pull the whole tool catalog into the client bundle.
// Verified checksum address on Base.
export const TOPUP_TREASURY = getAddress("0x02950Ad38aDA1D599375bD447E080cd404809205");

export const BASE_CHAIN_ID = 8453 as const;

// Credit pricing: 1 credit = $0.0005 → 1 USDC = 2000 credits.
export const CREDITS_PER_USDC = 2000;

export interface CreditPack {
  usdc:     number;   // USDC to send
  credits:  number;   // credits granted on settlement
  label:    string;
  popular?: boolean;
}

// Fixed packs surfaced in the Top-up modal. Amounts are round USDC figures so
// the on-chain transfer + the "≈ N credits" preview always agree exactly.
export const CREDIT_PACKS: CreditPack[] = [
  { usdc: 5,   credits: 5   * CREDITS_PER_USDC, label: "Starter" },
  { usdc: 20,  credits: 20  * CREDITS_PER_USDC, label: "Plus", popular: true },
  { usdc: 50,  credits: 50  * CREDITS_PER_USDC, label: "Pro" },
  { usdc: 100, credits: 100 * CREDITS_PER_USDC, label: "Scale" },
];

// Minimal ERC-20 transfer ABI — the only write the top-up flow makes.
export const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export function creditsForUsdc(usdc: number): number {
  return Math.floor(usdc * CREDITS_PER_USDC);
}
