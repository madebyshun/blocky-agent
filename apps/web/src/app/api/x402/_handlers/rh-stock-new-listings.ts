// x402/rh-stock-new-listings (D3) — detect newly deployed RH RWA tokens.
// Price: $0.05
//
// Enumerates every ERC-20 on Robinhood Chain via Blockscout tokens API,
// diffs against the canonical registry, and returns anything named with
// the Robinhood-Token pattern that isn't in the registry yet. Previous
// implementation used `/addresses/{deployer}/transactions?filter=from`
// which returned 0 hits because Blockscout doesn't populate
// `created_contract` on proxy-deployment txs; the tokens-list endpoint
// is the reliable source.

import { RH_CHAIN, RWA_TOKENS } from "@/lib/robinhood/rwa-registry";

const BS = "https://robinhoodchain.blockscout.com/api/v2";

// Canonical RHJ deployer per docs research + cross-checked on-chain via
// Blockscout `/addresses/{token}` → `creator_address_hash` for AAPL and
// MSTR. Same address deploys every beacon-proxy tokenized stock.
const RHJ_DEPLOYER = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";

// A Blockscout ERC-20 with a name like "Apple • Robinhood Token" is a
// canonical RHJ token even if its creator isn't fetched. We use this
// pattern to auto-detect new listings without a second per-token call.
const RHJ_NAME_MARKER = "Robinhood Token";

type BsToken = {
  address_hash?: string;
  name?: string;
  symbol?: string;
  decimals?: string;
  type?: string;
  holders_count?: string;
  total_supply?: string;
  circulating_market_cap?: string;
};
type Resp = { items?: BsToken[]; next_page_params?: unknown };

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { limit?: number; include_registered?: boolean } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, Number(body.limit ?? url.searchParams.get("limit") ?? 50)));
    const includeRegistered = body.include_registered === true;

    const timestamp = new Date().toISOString();
    let items: BsToken[] = [];
    let gt_fetch_status: string | null = null;
    try {
      const r = await fetch(`${BS}/tokens?type=ERC-20&limit=${limit}`, {
        signal: AbortSignal.timeout(10000),
        headers: { accept: "application/json" },
      });
      gt_fetch_status = `${r.status}`;
      if (r.ok) {
        const d = (await r.json()) as Resp;
        items = d.items ?? [];
      }
    } catch (e) {
      gt_fetch_status = `network_error: ${(e as Error).message}`;
    }

    const registeredContracts = new Set(RWA_TOKENS.map((t) => t.contract.toLowerCase()));
    const registeredTickers = new Set(RWA_TOKENS.map((t) => t.ticker.toUpperCase()));

    // Every ERC-20 name-tagged as an RHJ Robinhood Token = candidate RWA.
    const canonical = items.filter((t) => (t.name ?? "").includes(RHJ_NAME_MARKER));

    const new_only: Array<{ contract: string; name: string; symbol: string; decimals: number | null; holders: number | null; total_supply: string | null; in_registry_by_contract: boolean; in_registry_by_ticker: boolean }> = [];
    const registered_hits: typeof new_only = [];
    for (const t of canonical) {
      const addr = (t.address_hash ?? "").toLowerCase();
      const sym = (t.symbol ?? "").toUpperCase();
      const inByAddr = registeredContracts.has(addr);
      const inByTicker = registeredTickers.has(sym);
      const row = {
        contract: t.address_hash ?? "",
        name: t.name ?? "",
        symbol: t.symbol ?? "",
        decimals: t.decimals ? Number(t.decimals) : null,
        holders: t.holders_count ? Number(t.holders_count) : null,
        total_supply: t.total_supply ?? null,
        in_registry_by_contract: inByAddr,
        in_registry_by_ticker: inByTicker,
      };
      if (inByAddr) registered_hits.push(row);
      else new_only.push(row);
    }

    return Response.json({
      tool: "rh-stock-new-listings",
      erc20_scanned: items.length,
      rhj_named_found: canonical.length,
      registry_size: RWA_TOKENS.length,
      new_since_registry: new_only.length,
      new_only,
      registered_hits: includeRegistered ? registered_hits : undefined,
      deployer: RHJ_DEPLOYER,
      warnings: [
        new_only.length > 0 ? `${new_only.length} canonical RHJ token(s) not yet in the registry — inspect + promote via a registry PR` : null,
        gt_fetch_status && gt_fetch_status !== "200" ? `blockscout_status_${gt_fetch_status}` : null,
      ].filter((x): x is string => !!x),
      note: new_only.length > 0
        ? `${new_only.length} on-chain RHJ Robinhood Tokens are NOT in our registry (${new_only.slice(0, 3).map((r) => r.symbol).join(", ")}${new_only.length > 3 ? "…" : ""}).`
        : "Every on-chain RHJ Robinhood Token is already in the registry.",
      known_limitations: [
        `first_page_only: Blockscout /tokens returns up to ${limit} rows sorted by market cap. As RH Chain grows, a fresh RHJ deployment ranked below the cutoff will be missed until it enters the top ${limit}. Pass \`limit\` higher (up to 200) or paginate via next_page_params when this note stops being adequate.`,
        `name_marker_gate: detection relies on the "${RHJ_NAME_MARKER}" substring in token name. Any future RHJ listing that drops the marker will be missed.`,
      ],
      data_sources: ["robinhoodchain.blockscout.com API v2 /tokens"],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-new-listings failed", message: (e as Error).message }, { status: 500 });
  }
}
