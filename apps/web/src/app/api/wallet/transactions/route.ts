// GET /api/wallet/transactions?address=0x…&network=base|baseSepolia
//
// Real wallet transaction history for the BlueBank dashboard, from the Moralis
// Wallet History endpoint (decoded + categorized: send / receive / token swap /
// contract interaction). Each tx is normalized to a compact shape the UI can
// render directly and tab-filter (All / Deposits / Withdrawals / Swaps).
//
// Also returns a small `stats` block — this-month transfer count, estimated gas
// saved vs Ethereum L1, and net USDC flow — all computed IN CODE from the same
// real transfers (never fabricated; gas-saved is an explicit estimate). Needs
// MORALIS_API_KEY; degrades to an empty list + needsKey flag when absent.

import { NextResponse } from "next/server";

const MORALIS = "https://deep-index.moralis.io/api/v2.2";
// Moralis chain slug per BlueBank network. Base Sepolia = 0x14a34 (84532).
const CHAIN: Record<string, string> = { base: "base", baseSepolia: "0x14a34" };

interface Transfer {
  direction?: string;
  from_address?: string;
  to_address?: string;
  value_formatted?: string;
  token_symbol?: string;
}
interface MoralisTx {
  hash: string;
  block_timestamp?: string;
  category?: string;
  summary?: string;
  receipt_status?: string;
  possible_spam?: boolean;
  from_address?: string;
  to_address?: string;
  erc20_transfers?: Transfer[];
  native_transfers?: Transfer[];
}

type Kind = "received" | "sent" | "swap" | "contract";
interface Tx {
  hash: string;
  ts: number;
  category: string;
  kind: Kind;
  dir: "in" | "out" | "none";
  counterparty?: string;
  amount: number | null;
  asset?: string;
  status: "complete" | "pending" | "failed";
}

const num = (s?: string): number | null => {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// Map a Moralis history row → our compact tx. The per-transfer `direction`
// ("send" / "receive") is relative to the queried wallet, so we trust it for
// the icon + amount sign instead of re-deriving from raw addresses.
function normalize(t: MoralisTx): Tx {
  const ts = t.block_timestamp ? Date.parse(t.block_timestamp) : 0;
  const category = String(t.category ?? "");
  const status: Tx["status"] = t.receipt_status === "0" ? "failed" : "complete";
  const transfers: Transfer[] = [
    ...(Array.isArray(t.erc20_transfers) ? t.erc20_transfers : []),
    ...(Array.isArray(t.native_transfers) ? t.native_transfers : []),
  ];
  const incoming = transfers.find((x) => x.direction === "receive");
  const outgoing = transfers.find((x) => x.direction === "send");

  if (/swap/i.test(category)) {
    const got = incoming ?? outgoing;
    return {
      hash: t.hash, ts, category, kind: "swap", dir: "none",
      counterparty: t.to_address, amount: num(got?.value_formatted), asset: got?.token_symbol, status,
    };
  }
  if (incoming) {
    return {
      hash: t.hash, ts, category, kind: "received", dir: "in",
      counterparty: incoming.from_address, amount: num(incoming.value_formatted), asset: incoming.token_symbol, status,
    };
  }
  if (outgoing) {
    return {
      hash: t.hash, ts, category, kind: "sent", dir: "out",
      counterparty: outgoing.to_address, amount: num(outgoing.value_formatted), asset: outgoing.token_symbol, status,
    };
  }
  return {
    hash: t.hash, ts, category, kind: "contract", dir: "none",
    counterparty: t.to_address, amount: null, status,
  };
}

// Live ETH spot price (CoinGecko, no key) — only fetched when there's at least
// one transfer to value. null on any failure → gas-saved shows "—".
async function ethPriceUsd(): Promise<number | null> {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    return j.ethereum?.usd ?? null;
  } catch {
    return null;
  }
}

const emptyStats = () => ({
  transferCountMonth: 0, netFlowUsdcMonth: 0,
  gasSavedUsd: null as number | null, ethUsdPrice: null as number | null,
});

export async function GET(req: Request) {
  const u = new URL(req.url);
  const address = u.searchParams.get("address") ?? "";
  const network = u.searchParams.get("network") ?? "base";
  const chain = CHAIN[network] ?? "base";
  const key = process.env.MORALIS_API_KEY ?? "";

  if (!/^0x[a-fA-F0-9]{40}$/.test(address))
    return NextResponse.json({ transactions: [], stats: emptyStats(), error: "invalid address" });
  if (!key)
    return NextResponse.json({ transactions: [], stats: emptyStats(), needsKey: true });

  try {
    const res = await fetch(
      `${MORALIS}/wallets/${address}/history?chain=${chain}&order=DESC&limit=25`,
      { headers: { "X-API-Key": key, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(9000) },
    );
    if (!res.ok)
      return NextResponse.json({ transactions: [], stats: emptyStats(), error: `moralis ${res.status}` });

    const data = (await res.json()) as { result?: MoralisTx[] };
    const rows = (Array.isArray(data.result) ? data.result : []).filter((t) => !t.possible_spam);
    const transactions = rows.map(normalize).filter((t) => t.ts > 0);

    // ── Derived stats for the current calendar month (computed in code) ───────
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthTx = transactions.filter((t) => t.ts >= monthStart);
    const transferCountMonth = monthTx.filter((t) => t.kind === "received" || t.kind === "sent").length;
    const netFlowUsdcMonth = monthTx.reduce((acc, t) => {
      if (t.asset !== "USDC" || t.amount == null) return acc;
      if (t.kind === "received") return acc + t.amount;
      if (t.kind === "sent") return acc - t.amount;
      return acc;
    }, 0);
    // The live ETH price, fetched ONCE and handed to the client.
    //
    // It used to be fetched only when `transferCountMonth > 0`, because gas-saved
    // was its only consumer. It is now also the denominator of the portfolio
    // allocation, which a wallet with zero transfers still has — so the fetch is
    // unconditional and `null` (CoinGecko down / timed out) travels to the UI as
    // "unknown" rather than being replaced by a plausible-looking constant.
    const eth = await ethPriceUsd();
    // Gas saved vs Ethereum L1 — estimate: ~0.001 ETH per transfer × ETH price.
    const gasSavedUsd =
      eth != null && transferCountMonth > 0 ? +(0.001 * eth * transferCountMonth).toFixed(2) : null;

    return NextResponse.json({
      transactions,
      stats: { transferCountMonth, netFlowUsdcMonth: +netFlowUsdcMonth.toFixed(2), gasSavedUsd, ethUsdPrice: eth },
      ts: Date.now(),
    });
  } catch (e) {
    return NextResponse.json({ transactions: [], stats: emptyStats(), error: (e as Error).message });
  }
}
