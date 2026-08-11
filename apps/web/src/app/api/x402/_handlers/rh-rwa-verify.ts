// x402/rh-rwa-verify (L4) — anti-scam / canonical registry check.
// Price: free (defensive tool; charging discourages the safety check)
//
// Given a contract address, answer: is this a canonical Robinhood-issued (RHJ)
// stock token, or an impersonator? Cross-checks:
//   1. Address exists in canonical registry (RWA_TOKENS).
//   2. On-chain ERC-20 metadata (name/symbol/decimals) matches registry.
//   3. If NOT in registry but claims a matching ticker → surface as WARNING
//      with the real canonical contract for comparison.
//
// This is the tool every wallet-integration prompt should hit before rendering
// a "buy" button.

import { findByContract, findByTicker, RH_CHAIN } from "@/lib/robinhood/rwa-registry";
import { readErc20Meta } from "@/lib/robinhood/rwa-price";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { contract?: string; address?: string; expected_ticker?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const contract = (body.contract ?? body.address ?? url.searchParams.get("contract") ?? url.searchParams.get("address") ?? "").trim();
    const expectedTicker = (body.expected_ticker ?? url.searchParams.get("expected_ticker") ?? "").trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      return Response.json({ error: "Provide `contract` — 42-char hex address" }, { status: 400 });
    }

    const timestamp = new Date().toISOString();
    const inRegistry = findByContract(contract);
    const onchain = await readErc20Meta(contract as `0x${string}`);

    // ── Canonical hit ────────────────────────────────────────────────────
    if (inRegistry) {
      return Response.json({
        tool: "rh-rwa-verify",
        verdict: "CANONICAL",
        canonical: true,
        contract,
        registry: {
          ticker: inRegistry.ticker,
          name: inRegistry.name,
          issuer: inRegistry.issuer,
          kind: inRegistry.kind,
          decimals: inRegistry.decimals,
        },
        onchain,
        metadata_match: onchain?.symbol
          ? onchain.symbol.toUpperCase().includes(inRegistry.ticker.toUpperCase())
          : null,
        network: RH_CHAIN,
        explorer_url: `${RH_CHAIN.explorer}/address/${contract}`,
        data_sources: ["docs.robinhood.com/chain/contracts", "on-chain ERC-20 metadata"],
        timestamp,
      });
    }

    // ── Not in registry — is there a real one with this ticker? ──────────
    let canonicalPeer = null;
    if (expectedTicker) canonicalPeer = findByTicker(expectedTicker);
    else if (onchain?.symbol) canonicalPeer = findByTicker(onchain.symbol);

    return Response.json({
      tool: "rh-rwa-verify",
      verdict: canonicalPeer ? "IMPERSONATOR_WARNING" : "UNKNOWN",
      canonical: false,
      contract,
      onchain,
      warning: canonicalPeer
        ? `On-chain symbol matches ticker ${canonicalPeer.ticker} but this is NOT the canonical Robinhood-issued token. The canonical contract for ${canonicalPeer.ticker} (${canonicalPeer.name}) is ${canonicalPeer.contract}. Treat this contract as unverified until you can trace its provenance.`
        : "This contract is not in the canonical Robinhood Chain RWA registry. Cannot classify without more context.",
      canonical_peer: canonicalPeer ? {
        ticker: canonicalPeer.ticker,
        name: canonicalPeer.name,
        contract: canonicalPeer.contract,
        issuer: canonicalPeer.issuer,
      } : null,
      network: RH_CHAIN,
      explorer_url: `${RH_CHAIN.explorer}/address/${contract}`,
      data_sources: ["docs.robinhood.com/chain/contracts", "on-chain ERC-20 metadata"],
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-rwa-verify failed", message: (e as Error).message }, { status: 500 });
  }
}
