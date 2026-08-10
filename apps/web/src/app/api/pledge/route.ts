/**
 * GET /api/pledge            → the full ledger snapshot as JSON
 * GET /api/pledge?format=csv → the same rows as a downloadable CSV
 *
 * Public and unauthenticated on purpose: the whole point of the page is that a
 * holder — or a sceptic — can pull the raw list and check every row against a
 * block explorer without asking anyone's permission. The CSV exists so that
 * checking can happen in a spreadsheet rather than in our UI.
 *
 * HTTP status is 200 even when the ledger is degraded. A degraded read is not
 * a failed request; it is a successful request whose answer is "these numbers
 * are old, here is why". Returning 500 would make the client render nothing,
 * which on this page reads as every pledge having disappeared.
 */
import { NextResponse } from "next/server";
import { getLedger } from "@/lib/pledge/ledger";
import { CHAINS } from "@/lib/pledge/config";
import { rawToDecimalString } from "@/lib/pledge/format";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** RFC 4180: quote everything, double the quotes inside. */
const csvCell = (v: string | number | null | undefined): string =>
  `"${String(v ?? "").replace(/"/g, '""')}"`;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const wantsCsv = url.searchParams.get("format") === "csv";

  const rl = await rateLimit(getIdentifier(req), "api");
  if (!rl.success) {
    return NextResponse.json(
      { error: "rate limited", reset: rl.reset },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.reset - Date.now()) / 1000)) } },
    );
  }

  const snap = await getLedger();

  if (!wantsCsv) {
    return NextResponse.json(snap, {
      headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=120" },
    });
  }

  // One row per transaction, not per wallet — the row IS the receipt, so it
  // carries the hash that makes it checkable.
  const header = [
    "chain",
    "wallet",
    "tx_hash",
    "amount_raw",
    "amount",
    "timestamp_utc",
    "explorer_url",
  ];
  const lines = [header.join(",")];

  for (const w of snap.wallets) {
    const cfg = CHAINS[w.chain];
    for (const t of w.txs) {
      lines.push(
        [
          csvCell(cfg.shortLabel),
          csvCell(w.wallet),
          csvCell(t.txHash),
          csvCell(t.amount),
          csvCell(rawToDecimalString(t.amount, cfg.token.decimals)),
          csvCell(t.timestamp ? new Date(t.timestamp * 1000).toISOString() : ""),
          csvCell(cfg.explorerTx(t.txHash)),
        ].join(","),
      );
    }
  }

  const stamp = new Date(snap.updatedAt).toISOString().slice(0, 10);
  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="blueagent-pledges-${stamp}.csv"`,
      "Cache-Control": "public, max-age=15",
    },
  });
}
