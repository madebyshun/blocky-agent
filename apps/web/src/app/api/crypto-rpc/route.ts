/**
 * Venice Crypto RPC proxy
 *
 * Usage: POST /api/crypto-rpc
 *   { network: "base", method: "eth_getBalance", params: ["0x...", "latest"] }
 *
 * ⚠ REPAIRED 2026-09-05 (#170). Before this commit the route served NOTHING —
 * every network failed, not only Base. Two independent bugs, each on its own
 * sufficient to break every call. Both measured against the live API, not
 * inferred:
 *
 *   1. WRONG ID FORMAT. The hardcoded allowlist used bare chain names
 *      (`base`, `ethereum`, `arbitrum`, …). Venice's identifiers carry a
 *      network suffix (`base-mainnet`, `ethereum-sepolia`, …). Probing all 21
 *      entries returned 400 "Unsupported RPC network" for every single one —
 *      not one row was ever a valid id.
 *
 *   2. WRONG KEY PREFERRED. The route read `VENICE_INFERENCE_KEY ??
 *      VENICE_API_KEY`, and the inference key 401s on every crypto-RPC POST.
 *      It is a real, live Venice key — `GET /crypto/rpc/networks` with it
 *      returns 200 — it simply does not carry the crypto-RPC scope. Fixing (1)
 *      alone would only have turned a 400 into a 401.
 *
 * Verified working after both fixes: base-mainnet, robinhood-mainnet and
 * ethereum-mainnet each return a block height.
 *
 * This mattered because the chat system prompt tells the model "For onchain
 * reads: hub_crypto_rpc" — so every onchain-read request in Blue Chat was
 * routed to a tool that could not answer. Same family as #143 / #166 / #196:
 * advertising a capability the product does not have.
 *
 * THE ALLOWLIST IS NO LONGER WRITTEN DOWN HERE. It is read from Venice and
 * cached, for the same reason model ids are validated against the live
 * Virtuals catalog (`getVirtualsCatalog`) rather than a local copy: a
 * hand-maintained duplicate of a third party's identifier list is a guess, and
 * this particular guess was wrong in all 21 rows for as long as it existed. A
 * network Venice drops now fails with Venice's own message instead of a
 * confidently wrong local one.
 *
 * NOTE — non-EVM. Venice's catalog includes `solana-*` and `starknet-*`. They
 * are real entries and are deliberately NOT filtered out here, but they do not
 * answer `eth_*` methods; Venice replies with an explicit "methods are not
 * supported" error, which is passed through verbatim rather than second-guessed
 * locally.
 *
 * Venice docs: https://docs.venice.ai/api-reference/crypto-rpc
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
// Budget: catalog fetch (5s, cold only) + one RPC call (12s). A 401 retry costs
// almost nothing — Venice rejects an unauthorised key immediately rather than
// hanging. Kept under the caller's 30s timeout in api/chat/route.ts so this
// fails loudly here instead of silently 504-ing there.
export const maxDuration = 25;

const VENICE_BASE = "https://api.venice.ai/api/v1/crypto/rpc";

// 6h, matching getVirtualsCatalog. Venice's network list changes on the order
// of chain launches, not minutes.
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

let _catalog: { ids: Set<string>; fetchedAt: number } | null = null;

/**
 * Candidate API keys, most-likely-to-work first.
 *
 * VENICE_API_KEY leads because it is the one measured to carry the crypto-RPC
 * scope. VENICE_INFERENCE_KEY stays as a fallback rather than being dropped:
 * it is the key this route used to read, and production env is not guaranteed
 * to hold the same pair as local. Callers step to the next key ONLY on 401 —
 * any other status is a real answer from Venice and is returned as-is.
 */
function veniceKeys(): string[] {
  return [process.env.VENICE_API_KEY, process.env.VENICE_INFERENCE_KEY]
    .filter((k): k is string => !!k)
    .filter((k, i, all) => all.indexOf(k) === i);
}

/**
 * The set of network ids Venice will actually serve.
 *
 * Returns `null` when the catalog cannot be established at all. `null` means
 * "cannot validate", NOT "nothing is supported" — the caller then forwards the
 * request and lets Venice decide, which is the honest degradation. Inventing a
 * local verdict from a failed lookup is exactly the bug this function replaces.
 */
async function getVeniceNetworks(): Promise<Set<string> | null> {
  const now = Date.now();
  if (_catalog && now - _catalog.fetchedAt < CATALOG_TTL_MS) return _catalog.ids;

  for (const key of veniceKeys()) {
    try {
      const res = await fetch(`${VENICE_BASE}/networks`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 401) continue; // wrong scope — try the next key
      if (!res.ok) break;

      const data = (await res.json()) as { networks?: unknown };
      if (!Array.isArray(data.networks)) break;

      const ids = new Set(data.networks.filter((n): n is string => typeof n === "string"));
      if (ids.size === 0) break; // an empty list is an outage, not an answer

      _catalog = { ids, fetchedAt: now };
      return ids;
    } catch {
      break;
    }
  }

  if (_catalog) {
    console.warn("[crypto-rpc] catalog refresh failed — serving stale list");
    return _catalog.ids;
  }
  console.warn("[crypto-rpc] no network catalog — forwarding unvalidated, Venice will answer");
  return null;
}

/**
 * Map what a caller wrote onto a Venice network id.
 *
 * Every existing caller — including the chat tool schema — says `base`, while
 * Venice wants `base-mainnet`. Exact ids win first so a caller can still reach
 * a testnet explicitly (`base-sepolia`); otherwise the bare name is tried with
 * the `-mainnet` suffix. Anything unrecognised is passed through untouched so
 * Venice gets to reject it in its own words.
 */
function resolveNetwork(input: string, catalog: Set<string> | null): string {
  if (!catalog) return input.includes("-") ? input : `${input}-mainnet`;
  if (catalog.has(input)) return input;
  const mainnet = `${input}-mainnet`;
  if (catalog.has(mainnet)) return mainnet;
  return input;
}

export async function POST(req: NextRequest) {
  const keys = veniceKeys();
  if (keys.length === 0) {
    return NextResponse.json({ error: "Venice Crypto RPC not configured." }, { status: 503 });
  }

  let body: { network?: string; method?: string; params?: unknown[] } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { network = "base", method, params = [] } = body;
  if (!method) {
    return NextResponse.json({ error: "method is required." }, { status: 400 });
  }

  const catalog = await getVeniceNetworks();
  const resolved = resolveNetwork(network, catalog);

  // Only reject locally when we hold a catalog to reject against.
  if (catalog && !catalog.has(resolved)) {
    return NextResponse.json(
      {
        error: `Unsupported network: ${network}.`,
        supported: [...catalog].sort(),
      },
      { status: 400 },
    );
  }

  let unauthorizedDetail = "";
  for (const key of keys) {
    try {
      const res = await fetch(`${VENICE_BASE}/${resolved}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(12_000),
      });

      if (res.status === 401) {
        unauthorizedDetail = await res.text();
        continue; // this key lacks the crypto-RPC scope — try the next
      }

      if (!res.ok) {
        const err = await res.text();
        return NextResponse.json(
          { error: `Venice RPC error ${res.status}`, detail: err, network: resolved },
          { status: res.status },
        );
      }

      const data = await res.json();
      // `network` is echoed so the caller (and the model reading this in chat)
      // can see which network actually answered after alias resolution, rather
      // than assuming the one it asked for.
      return NextResponse.json({ ...data, network: resolved });
    } catch (e) {
      return NextResponse.json(
        { error: `RPC request failed: ${(e as Error).message}`, network: resolved },
        { status: 502 },
      );
    }
  }

  return NextResponse.json(
    {
      error: "Venice rejected every configured API key (401).",
      detail: unauthorizedDetail.slice(0, 300),
    },
    { status: 502 },
  );
}
