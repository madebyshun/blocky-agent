// x402/rh-stock-new-listings (D3) — detect newly deployed RH RWA tokens.
// Price: $0.05
//
// Reads the RHJ factory's own deployment log and diffs it against the canonical
// registry. Anything the factory minted that the registry lacks is a genuine
// new listing — and is deployer-verified by construction, not by inference.
//
// ── Two dead ends before this one, both the same mistake ───────────────────
// v1 called `/addresses/{deployer}/transactions?filter=from` and got 0 hits,
// because Blockscout doesn't populate `created_contract` on proxy-deployment
// txs. v2 switched to the token list — `/api/v2/tokens?type=ERC-20`, filtered
// to the RHJ name marker — and that is the one worth remembering, because it
// looked like it worked. `/tokens` is ranked by market cap and serves a fixed
// 50-row page (it accepts `limit` and ignores it, measured at 50/100/200). So
// the tool could only see tokens that already had a pool, while the entire
// point of a *new-listing* detector is the token that doesn't have one yet.
// It reported "every RHJ token on this page is already in the registry" while
// 107 real deployments sat below the cutoff, invisible.
//
// ── Why the factory log is the right index ─────────────────────────────────
// `RH_RWA_DEPLOYER` is an ERC1967Proxy factory, and each canonical token is
// born from a `deploy` call on it that emits:
//
//     Deployed(bytes32 indexed uid, address stock, string name, string symbol)
//
// An event cannot be ranked out of a list, so the crawl is complete rather
// than a prefix; it is ordered newest-first, which is the question this tool
// is actually asking; and it needs no per-token creator lookup, because a
// contract cannot emit another contract's events. Membership in this log *is*
// the provenance proof. The fake GME (0x1c8a973a…, 2,362 holders) and fake
// USAR (0x38D6254b…, 4,877 holders) came out of thirdweb's TWCloneFactory and
// can never appear here, at any depth, regardless of what they call themselves.
//
// ── Why there is no `impersonators` field ──────────────────────────────────
// The previous version returned one, populated by name-matching the same
// market-cap-ranked page. It came back `[]` on every call — not because the
// chain is clean (a full crawl finds ~500 contracts carrying the "Robinhood
// Token" name against 203 genuine ones) but because impersonators have no
// market cap and sort last. An always-empty field named `impersonators` on a
// paid security-adjacent tool reads as a clean bill of health, so it is gone
// rather than misleading. Checking one specific address is `rh-rwa-verify`'s
// job, and that answer is complete.

import { RH_CHAIN, RWA_TOKENS, RH_RWA_DEPLOYER } from "@/lib/robinhood/rwa-registry";

const BS = "https://robinhoodchain.blockscout.com/api/v2";

// Pagination ceiling. The factory has emitted ~203 events across 5 pages, so
// this is ~6× headroom; hitting it means the response is a prefix and says so.
const MAX_PAGES = 30;

const SUFFIX = " • Robinhood Token";

type BsLog = {
  block_number?: number;
  block_timestamp?: string;
  transaction_hash?: string;
  decoded?: { method_call?: string; parameters?: { name: string; value: string }[] };
};
type Resp = { items?: BsLog[]; next_page_params?: Record<string, string | number | null> | null };

type Deployment = {
  contract: string;
  ticker: string;
  name: string;
  deployed_at_block: number | null;
  deployed_at: string | null;
  deploy_tx: string | null;
  in_registry: boolean;
};

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { limit?: number; since_days?: number } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(100, Number(body.limit ?? url.searchParams.get("limit") ?? 20)));
    const sinceDays = Math.max(1, Math.min(3650, Number(body.since_days ?? url.searchParams.get("since_days") ?? 30)));
    const cutoff = Date.now() - sinceDays * 86400_000;

    const timestamp = new Date().toISOString();
    const deployments: Deployment[] = [];
    const seen = new Set<string>();
    const registered = new Set(RWA_TOKENS.map((t) => t.contract.toLowerCase()));

    let fetch_status: string | null = null;
    let pages_fetched = 0;
    let scan_complete = false;

    try {
      let next: Record<string, string | number | null> | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(next ?? {})) {
          if (v !== null && v !== undefined) qs.set(k, String(v));
        }
        const r = await fetch(`${BS}/addresses/${RH_RWA_DEPLOYER}/logs?${qs}`, {
          signal: AbortSignal.timeout(10000),
          headers: { accept: "application/json" },
        });
        fetch_status = `${r.status}`;
        if (!r.ok) break;
        const d = (await r.json()) as Resp;
        pages_fetched++;
        for (const l of d.items ?? []) {
          if (!l.decoded?.method_call?.startsWith("Deployed(")) continue;
          const get = (n: string) => l.decoded?.parameters?.find((x) => x.name === n)?.value;
          const stock = get("stock");
          if (!stock || seen.has(stock.toLowerCase())) continue;
          seen.add(stock.toLowerCase());
          const rawName = get("name") ?? "";
          deployments.push({
            contract: stock,
            ticker: (get("symbol") ?? "").toUpperCase(),
            name: rawName.endsWith(SUFFIX) ? rawName.slice(0, -SUFFIX.length) : rawName,
            deployed_at_block: l.block_number ?? null,
            deployed_at: l.block_timestamp ?? null,
            deploy_tx: l.transaction_hash ?? null,
            in_registry: registered.has(stock.toLowerCase()),
          });
        }
        next = d.next_page_params ?? null;
        if (!next || (d.items ?? []).length === 0) { scan_complete = true; break; }
      }
    } catch (e) {
      fetch_status = `network_error: ${(e as Error).message}`;
    }

    // Blockscout serves logs newest-first; sort defensively so the "latest"
    // slice is right even if that ever changes.
    deployments.sort((a, b) => (b.deployed_at_block ?? 0) - (a.deployed_at_block ?? 0));

    // Deliberately NOT filtered by `since_days`: a factory deployment absent
    // from the registry is a gap whether it happened yesterday or last year,
    // and silently hiding the old ones behind a time window is how a registry
    // drifts without anyone noticing.
    const new_only = deployments.filter((d) => !d.in_registry);

    const inWindow = deployments.filter((d) => {
      const t = d.deployed_at ? Date.parse(d.deployed_at) : NaN;
      return Number.isFinite(t) && t >= cutoff;
    });

    return Response.json({
      tool: "rh-stock-new-listings",
      factory: RH_RWA_DEPLOYER,
      deployments_found: deployments.length,
      pages_fetched,
      /** False means the crawl stopped early — treat the answer as a prefix. */
      scan_complete,
      registry_size: RWA_TOKENS.length,
      new_since_registry: new_only.length,
      /**
       * Factory-deployed tokens missing from the registry. Provenance here is
       * structural, not inferred: the RHJ factory emitted these events itself.
       * Covers the whole log, not just `since_days`.
       */
      new_only,
      window_days: sinceDays,
      deployments_in_window: inWindow.length,
      /** Deployments inside `since_days`, newest first, capped at `limit`. */
      recent_deployments: inWindow.slice(0, limit),
      warnings: [
        new_only.length > 0
          ? `${new_only.length} factory-deployed token(s) are not in the registry — regenerate it with \`npx tsx scripts/rwa-generate.ts --write\``
          : null,
        !scan_complete
          ? "crawl did not reach the end of the factory log — new_since_registry is a lower bound, not a count"
          : null,
        fetch_status && fetch_status !== "200" ? `blockscout_status_${fetch_status}` : null,
      ].filter((x): x is string => !!x),
      note: new_only.length > 0
        ? `${new_only.length} RHJ factory deployment(s) are NOT in our registry (${new_only.slice(0, 3).map((r) => r.ticker).join(", ")}${new_only.length > 3 ? "…" : ""}).`
        : `Registry is level with the chain: all ${deployments.length} RHJ factory deployments are listed. ${inWindow.length} of them landed in the last ${sinceDays} day(s).`,
      known_limitations: [
        `provenance_only: presence here proves the RHJ factory deployed the token. It says nothing about liquidity — most RH stock tokens have no pool and no Chainlink feed, so a brand-new listing is typically untradable at first. Check depth before acting on it.`,
        `no_scam_enumeration: this tool lists what the real factory built, so impersonators cannot appear in it — but it does not and cannot enumerate them either. To check whether a specific address is genuine, call rh-rwa-verify with that address.`,
        `event_shape_dependency: the crawl matches the factory's \`Deployed(bytes32,address,string,string)\` event. If RHJ deploys future tokens through a different factory or event, they will be missed until this handler and the registry generator are updated together.`,
      ],
      data_sources: [
        `robinhoodchain.blockscout.com API v2 /addresses/${RH_RWA_DEPLOYER}/logs — Deployed events`,
      ],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-new-listings failed", message: (e as Error).message }, { status: 500 });
  }
}
