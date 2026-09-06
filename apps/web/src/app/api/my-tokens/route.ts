import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 20;

/**
 * GET /api/my-tokens?address=0x… — tokens launched by a wallet + their unclaimed
 * creator fees, for the /app/launches "My Tokens" tab.
 *
 * Thin proxy over Bankr's PUBLIC, UNAUTHENTICATED Doppler creator-fees endpoint
 * (verified live 2026-06-27):
 *   GET https://api.bankr.bot/public/doppler/creator-fees/:address?days=30
 * Each token carries claimable / claimed amounts split across the pool's two
 * sides (token0Label / token1Label — one side is WETH, the other the token).
 *
 * ZERO fabrication: we pass through Bankr's raw amount strings verbatim. No USD
 * value is invented. Proxying server-side avoids browser CORS and keeps the
 * normalisation in one place.
 */

const BANKR_FEES = "https://api.bankr.bot/public/doppler/creator-fees";

export interface MyToken {
  tokenAddress: string;
  name: string;
  symbol: string;
  poolId: string | null;
  share: string | null;            // e.g. "57.00%"
  token0Label: string | null;
  token1Label: string | null;
  claimable: { token0: string; token1: string };
  claimed: { token0: string; token1: string; count: number };
  /** true when either claimable side parses to a positive number. */
  hasClaimable: boolean;
  /**
   * Which chain these fees live on, straight from Bankr's row. The response is
   * ALL-CHAINS — the `?chain=` query param is ignored and every row carries its
   * own `chain` (measured 2026-09-06: 26 base + 7 robinhood). The top-level
   * `chain` is only an echo/default label, so per-row is the only correct read.
   * This used to be dropped here, leaving the client to guess the chain from a
   * local KV launch record that does not cover every fee-bearing token.
   */
  chain: "base" | "robinhood" | null;
  chainId: number | null;
}

export interface MyTokensResponse {
  ok: boolean;
  address: string;
  tokens: MyToken[];
  error?: string;
}

function toNum(s: unknown): number {
  const n = typeof s === "string" ? parseFloat(s) : typeof s === "number" ? s : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function GET(req: NextRequest) {
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json<MyTokensResponse>(
      { ok: false, address, tokens: [], error: "Invalid wallet address." },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BANKR_FEES}/${address}?days=30`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError"
      ? "Bankr did not respond in time. Try again."
      : `Bankr fees endpoint unreachable: ${(e as Error).message}`;
    return NextResponse.json<MyTokensResponse>(
      { ok: false, address, tokens: [], error: msg },
      { status: 502 },
    );
  }

  const data = (await upstream.json().catch(() => null)) as
    | { tokens?: Array<Record<string, unknown>> }
    | null;

  if (!upstream.ok || !data) {
    return NextResponse.json<MyTokensResponse>(
      { ok: false, address, tokens: [], error: `Bankr returned status ${upstream.status}.` },
      { status: 502 },
    );
  }

  const raw = Array.isArray(data.tokens) ? data.tokens : [];
  const tokens: MyToken[] = raw.map((t) => {
    const claimable = (t.claimable ?? {}) as { token0?: unknown; token1?: unknown };
    const claimed = (t.claimed ?? {}) as { token0?: unknown; token1?: unknown; count?: unknown };
    const c0 = String(claimable.token0 ?? "0");
    const c1 = String(claimable.token1 ?? "0");
    // Unrecognised chain → null, never a guessed default. An address on the
    // wrong chain is meaningless (CLAUDE.md), so "unknown" beats "probably Base".
    const chain = t.chain === "robinhood" ? "robinhood" as const
      : t.chain === "base" ? "base" as const
      : null;
    return {
      chain,
      chainId: chain === "robinhood" ? 4663 : chain === "base" ? 8453 : null,
      tokenAddress: String(t.tokenAddress ?? ""),
      name: String(t.name ?? ""),
      symbol: String(t.symbol ?? ""),
      poolId: t.poolId ? String(t.poolId) : null,
      share: t.share ? String(t.share) : null,
      token0Label: t.token0Label ? String(t.token0Label) : null,
      token1Label: t.token1Label ? String(t.token1Label) : null,
      claimable: { token0: c0, token1: c1 },
      claimed: {
        token0: String(claimed.token0 ?? "0"),
        token1: String(claimed.token1 ?? "0"),
        count: toNum(claimed.count),
      },
      hasClaimable: toNum(c0) > 0 || toNum(c1) > 0,
    };
  }).filter((t) => t.tokenAddress);

  return NextResponse.json<MyTokensResponse>(
    { ok: true, address, tokens },
    { headers: { "Cache-Control": "private, max-age=15" } },
  );
}
