/**
 * x402 settlement ledger — real USDC settled on Base via the Coinbase CDP facilitator.
 *
 * Every paid tool call that clears CDP `/settle` moves USDC on-chain to the Blue
 * Agent treasury (0x0295…). We record ONLY confirmed settlements (settle.ok === true)
 * here so the /stats page can show the actual amount Coinbase CDP has settled —
 * not the runs×price ESTIMATE (which counts internal-bypass / free / failed-settle
 * calls too). The number is therefore a strict, honest lower-bound of paid volume.
 *
 * Aggregate only: a running count + summed micro-units + the latest tx hash (for a
 * one-click Basescan proof). No wallet, no per-user data is ever stored — the payer
 * address is never part of any key or value.
 *
 * Forward-only, like the `usage:<id>` run counters: it starts accruing at deploy
 * time. That is intentional and truthful — it is a live meter of CDP settlements,
 * not a backfilled historical total. A KV failure degrades every read to null so
 * /stats renders an honest "—", never a fabricated figure.
 */
import { kv, kvGet } from "@/lib/kv";

const K_COUNT = "x402:settle:count";  // # of confirmed CDP settlements
const K_UNITS = "x402:settle:units";  // Σ USDC micro-units settled (6 decimals)
const K_LASTTX = "x402:settle:lasttx"; // most-recent on-chain tx hash (Base)

export interface X402Settlements {
  count: number;         // confirmed on-chain settlements via Coinbase CDP
  units: number;         // raw USDC micro-units (6 decimals)
  usdc:  number;         // human USDC (units / 1e6)
  lastTx: string | null; // latest settlement tx hash on Base, for Basescan proof
}

/**
 * Record ONE confirmed CDP settlement. Call ONLY when cdpSettle().ok === true.
 * Best-effort and non-throwing: a KV hiccup must never break the paid response
 * (the USDC already moved — bookkeeping is secondary).
 */
export async function recordSettlement(units: number, tx?: string | null): Promise<void> {
  if (!Number.isFinite(units) || units <= 0) return;
  try {
    await Promise.all([
      kv.incr(K_COUNT),
      kv.incrby(K_UNITS, Math.round(units)),
      tx ? kv.set(K_LASTTX, tx) : Promise.resolve(),
    ]);
  } catch { /* bookkeeping is best-effort */ }
}

/** Read the aggregate settlement meter. Null on total KV failure → /stats shows "—". */
export async function getX402Settlements(): Promise<X402Settlements | null> {
  try {
    const [count, units, lastTx] = await Promise.all([
      kvGet<number>(K_COUNT),
      kvGet<number>(K_UNITS),
      kvGet<string>(K_LASTTX),
    ]);
    const u = units ?? 0;
    return {
      count:  count ?? 0,
      units:  u,
      usdc:   u / 1_000_000,
      lastTx: lastTx ?? null,
    };
  } catch {
    return null;
  }
}
