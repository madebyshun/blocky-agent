// x402/rh-rwa-verify (L4) — anti-scam / canonical registry check.
// Price: free (defensive tool; charging discourages the safety check)
//
// Given a contract address, answer: is this a canonical Robinhood-issued (RHJ)
// stock token, or an impersonator? Cross-checks:
//   1. Contract provenance — who deployed it. Canonical RHJ tokens all share
//      one creator (`RH_RWA_DEPLOYER`). This is the only signal here an
//      impersonator cannot forge.
//   2. Address exists in canonical registry (RWA_TOKENS).
//   3. On-chain ERC-20 metadata (name/symbol/decimals) matches registry.
//   4. If NOT in registry but claims a matching ticker → surface as WARNING
//      with the real canonical contract for comparison.
//
// ── Why provenance had to be added ─────────────────────────────────────────
// Registry membership alone can only answer "have we seen this address?", so a
// real token listed after our last registry edit looked exactly like a scam.
// Meanwhile the live fakes on this chain copy the name byte-for-byte — the
// counterfeit GME at 0x1c8a973a… is literally "GameStop • Robinhood Token"
// with 2,362 holders — so the old symbol-substring check cleared them too.
// The creator address separates the two cases and does not go stale.
//
// This is the tool every wallet-integration prompt should hit before rendering
// a "buy" button.

import {
  findByContract,
  findByTicker,
  RH_CHAIN,
  RH_RWA_DEPLOYER,
} from "@/lib/robinhood/rwa-registry";
import { readErc20Meta } from "@/lib/robinhood/rwa-price";
import { getContractCreator } from "@/lib/robinhood/blockscout";

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
    const [onchain, creator] = await Promise.all([
      readErc20Meta(contract as `0x${string}`),
      getContractCreator(contract),
    ]);

    // Tri-state on purpose. `null` = Blockscout didn't tell us, which is NOT
    // the same as "deployed by someone else" — collapsing the two would let a
    // transient explorer failure read as an accusation.
    const deployed_by_rhj: boolean | null = creator
      ? creator.toLowerCase() === RH_RWA_DEPLOYER.toLowerCase()
      : null;
    const provenance = {
      creator,
      expected_deployer: RH_RWA_DEPLOYER,
      deployed_by_rhj,
      checked: creator !== null,
    };
    const data_sources = [
      "on-chain ERC-20 metadata",
      "robinhoodchain.blockscout.com — contract creator",
      "docs.robinhood.com/chain/contracts",
    ];

    // ── Canonical hit ────────────────────────────────────────────────────
    if (inRegistry) {
      // A registry row whose on-chain creator is NOT the RHJ deployer means
      // OUR address book is wrong, not that the caller found a scam. Say so
      // in those words — WETH/USDG are legitimately non-RHJ.
      const registryProvenanceOk =
        inRegistry.issuer !== "RHJ" || deployed_by_rhj !== false;
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
        provenance,
        metadata_match: onchain?.symbol
          ? onchain.symbol.trim().toUpperCase() === inRegistry.ticker.toUpperCase()
          : null,
        warnings: registryProvenanceOk
          ? []
          : [
              `REGISTRY BUG: ${inRegistry.ticker} is recorded as RHJ-issued but ${contract} was deployed by ${creator}, not ${RH_RWA_DEPLOYER}. Do not trade on this row until it is corrected.`,
            ],
        network: RH_CHAIN,
        explorer_url: `${RH_CHAIN.explorer}/address/${contract}`,
        data_sources,
        timestamp,
      });
    }

    // ── Not in registry — is there a real one with this ticker? ──────────
    let canonicalPeer = null;
    if (expectedTicker) canonicalPeer = findByTicker(expectedTicker);
    else if (onchain?.symbol) canonicalPeer = findByTicker(onchain.symbol);

    // Provenance outranks registry membership here. Robinhood lists new stocks
    // faster than this repo merges registry PRs, so "absent from RWA_TOKENS"
    // on its own says nothing about authenticity — the deployer does.
    const verdict =
      deployed_by_rhj === true
        ? "CANONICAL_UNLISTED"
        : deployed_by_rhj === false
          ? "IMPERSONATOR_WARNING"
          : canonicalPeer
            ? "IMPERSONATOR_WARNING"
            : "UNKNOWN";

    const peerLine = canonicalPeer
      ? ` The canonical contract for ${canonicalPeer.ticker} (${canonicalPeer.name}) is ${canonicalPeer.contract}.`
      : "";

    const warning =
      verdict === "CANONICAL_UNLISTED"
        ? `Deployed by the canonical Robinhood issuer (${RH_RWA_DEPLOYER}) but not yet in this registry — most likely a listing newer than our last registry update. Safe to treat as RHJ-issued; open a registry PR so the rest of the tools can resolve it by ticker.`
        : deployed_by_rhj === false
          ? `NOT issued by Robinhood. ${contract} was deployed by ${creator}, not the canonical RHJ deployer ${RH_RWA_DEPLOYER} — the name and symbol can be copied, the deployer cannot.${peerLine} Do not trade this.`
          : canonicalPeer
            ? `On-chain symbol matches ticker ${canonicalPeer.ticker} but this is NOT the canonical Robinhood-issued token.${peerLine} Provenance could not be checked, so treat this contract as unverified.`
            : "This contract is not in the canonical Robinhood Chain RWA registry and its deployer could not be read. Cannot classify without more context.";

    return Response.json({
      tool: "rh-rwa-verify",
      verdict,
      canonical: verdict === "CANONICAL_UNLISTED",
      contract,
      onchain,
      provenance,
      warning,
      canonical_peer: canonicalPeer ? {
        ticker: canonicalPeer.ticker,
        name: canonicalPeer.name,
        contract: canonicalPeer.contract,
        issuer: canonicalPeer.issuer,
      } : null,
      network: RH_CHAIN,
      explorer_url: `${RH_CHAIN.explorer}/address/${contract}`,
      data_sources,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-rwa-verify failed", message: (e as Error).message }, { status: 500 });
  }
}
