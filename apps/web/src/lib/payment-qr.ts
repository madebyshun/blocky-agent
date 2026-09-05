// Payment-QR helpers for BlueBank scan-to-pay (Base).
//
// Parses what a camera scans into a Send prefill, and builds an EIP-681
// payment-request URI for the Receive QR. Supports:
//   • plain EVM address            0xabc…                → { to }
//   • Basename / ENS               shop.base / shop.eth  → { to } (resolved later)
//   • EIP-681 ETH transfer         ethereum:0xRecip@8453?value=1e18
//   • EIP-681 token (USDC) transfer ethereum:<usdc>@8453/transfer?address=0xRecip&uint256=1000000
//
// Chains come from WALLET_CHAINS, so this follows whatever the wallet supports
// rather than pinning its own list. USDC is classified by matching the target
// contract against the verified USDC address for that chain — and only for
// chains that actually settle in USDC (see `usdcFor`).

import { formatUnits, parseUnits } from "viem";
import { WALLET_CHAINS, walletChainByChainId, type WalletChain } from "./wallet/chains";

export type ParsedPayment = {
  to?: string;                 // 0x address or name.base
  amount?: string;             // human units
  asset?: "USDC" | "ETH";
  network?: WalletChain;
};

const isAddr = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(s);
const isName = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(base|eth)$/i.test(s);

/**
 * The USDC contract on `chainId`, or undefined if that chain doesn't settle in
 * USDC. The `stableSymbol` guard is load-bearing: Robinhood Chain's stable is
 * USDG, and without it a USDG transfer would come back tagged `asset: "USDC"` —
 * a wrong token name on a payment prefill, which is the worst place to be wrong.
 */
function usdcFor(chainId: number): string | undefined {
  const net = walletChainByChainId(chainId);
  if (!net) return undefined;
  const cfg = WALLET_CHAINS[net];
  return cfg.stableSymbol === "USDC" ? cfg.stable.toLowerCase() : undefined;
}

// EIP-681 number values may be integers ("1000000") or scientific ("1e18").
function toHuman(v: string, decimals: number): string {
  try {
    if (/^\d+$/.test(v)) return formatUnits(BigInt(v), decimals);
    const n = Number(v) / 10 ** decimals;
    return isFinite(n) ? String(n) : "";
  } catch {
    return "";
  }
}

/** Parse a scanned QR string into a Send prefill, or null if unrecognized. */
export function parsePaymentQr(raw: string): ParsedPayment | null {
  const text = (raw || "").trim();
  if (!text) return null;

  if (isAddr(text)) return { to: text };
  if (isName(text)) return { to: text };

  // ethereum:<target>[@chainId][/fn]?[k=v&…]
  const m = text.match(/^ethereum:([^@/?]+)(?:@(\d+))?(?:\/([a-zA-Z]+))?(?:\?(.*))?$/i);
  if (m) {
    const target = m[1];
    const chainId = m[2] ? parseInt(m[2], 10) : 8453;
    const fn = (m[3] || "").toLowerCase();
    const params = new URLSearchParams(m[4] || "");
    const network = walletChainByChainId(chainId);

    if (fn === "transfer") {
      const recip = params.get("address") || params.get("recipient") || undefined;
      const rawAmt = params.get("uint256") || params.get("amount") || undefined;
      const isUsdc = target.toLowerCase() === usdcFor(chainId);
      const decimals = isUsdc && network ? WALLET_CHAINS[network].stableDecimals : 6;
      // EIP-681 transfer recipient must be a real 0x address — reject anything
      // else (don't prefill a garbage "to"). undefined = no recipient parsed.
      return {
        to: recip && isAddr(recip) ? recip : undefined,
        asset: isUsdc ? "USDC" : undefined,
        amount: rawAmt ? toHuman(rawAmt, decimals) : undefined,
        network,
      };
    }

    // plain native transfer → target is the recipient, value in wei
    const val = params.get("value") || params.get("amount") || undefined;
    return {
      to: target,
      asset: "ETH",
      amount: val ? toHuman(val, 18) : undefined,
      network,
    };
  }

  return null;
}

/**
 * Build an EIP-681 payment-request URI for the Receive QR.
 * No amount → returns the bare address (universally scannable).
 */
export function buildPaymentUri(opts: {
  to: string;
  amount?: string;
  asset?: "USDC" | "ETH";
  network: WalletChain;
}): string {
  const { to, amount, asset = "USDC", network } = opts;
  const amt = parseFloat(amount ?? "");
  if (!to) return "";
  if (!(amt > 0)) return to; // plain address QR

  // Read the chainId off the config rather than a second hand-maintained table.
  // There used to be a NET_TO_CHAIN literal here that had to be edited in lockstep
  // with the network list; a chain added to one and not the other would have
  // built a QR pointing at the wrong network.
  const cfg = WALLET_CHAINS[network];
  if (asset === "ETH") {
    const wei = parseUnits(String(amount), 18).toString();
    return `ethereum:${to}@${cfg.chainId}?value=${wei}`;
  }
  const units = parseUnits(String(amount), cfg.stableDecimals).toString();
  return `ethereum:${cfg.stable}@${cfg.chainId}/transfer?address=${to}&uint256=${units}`;
}
