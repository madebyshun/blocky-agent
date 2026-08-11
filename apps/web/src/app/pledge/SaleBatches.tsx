/**
 * /pledge — the sale batch record.
 *
 * After the pledge window closes, pledged tokens are sold in batches to fund
 * the $NEW pool. Each sale is published here with its transaction hash, and the
 * proceeds decide the airdrop split between the two chains. That makes this
 * section the evidence behind an allocation number, not a progress widget.
 *
 * A SERVER component, like the rest of the page above the ledger: the batches
 * come from a file committed to the repo, so there is nothing to fetch and no
 * reason for this to depend on JavaScript running.
 *
 * Renders NOTHING while there are no batches. Before the window closes there
 * have been no sales, and an empty table with a 0% split invites the reader to
 * treat a placeholder as a published figure.
 */
import { CHAINS } from "@/lib/pledge/config";
import {
  loadSaleBatches,
  computeTotals,
  formatScaled,
  fmtBps,
  type SaleBatchRow,
} from "@/lib/pledge/sales";

const ACCENT: Record<string, string> = { base: "#4FC3F7", rh: "#34D399" };

const COLUMNS = ["#", "Chain", "Tokens sold", "Received", "Avg price", "Sale tx", "Swap tx"];

const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

function fmtDate(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function TxLink({ chain, hash }: { chain: SaleBatchRow["chain"]; hash: string }) {
  return (
    <a
      href={CHAINS[chain].explorerTx(hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-[11px] text-slate-500 hover:text-[#4FC3F7] transition-colors"
      title={hash}
    >
      {shortHash(hash)} ↗
    </a>
  );
}

export default function SaleBatches() {
  const rows = loadSaleBatches();
  if (rows.length === 0) return null;

  const t = computeTotals(rows);

  return (
    <section className="max-w-5xl mx-auto px-6 pb-16">
      <h2 className="text-xl font-bold text-white mb-1.5">Sale batches</h2>
      <p className="text-[13px] text-slate-400 leading-relaxed mb-6 max-w-2xl">
        Pledged tokens are sold in batches to fund the $NEW launch pool. Every sale is listed
        here with its transaction, and the proceeds are what set the airdrop split between the
        two chains.
      </p>

      <div className="overflow-x-auto rounded-2xl border border-[#1A1A2E] mb-4">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-[#0a0a10]">
              {COLUMNS.map((h) => (
                <th
                  key={h}
                  className="font-mono text-[10px] uppercase tracking-[0.15em] text-slate-600 px-4 py-3 whitespace-nowrap font-normal"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className="border-t border-[#1A1A2E] hover:bg-[#0a0a10]">
                <td className="px-4 py-3 font-mono text-[11px] text-slate-600 tabular-nums">
                  {b.id}
                </td>
                <td className="px-4 py-3">
                  <span
                    className="font-mono text-[10px] px-2 py-1 rounded-md"
                    style={{ background: `${ACCENT[b.chain]}14`, color: ACCENT[b.chain] }}
                  >
                    {CHAINS[b.chain].shortLabel}
                  </span>
                </td>
                <td
                  className="px-4 py-3 font-mono text-[12px] text-white tabular-nums whitespace-nowrap"
                  title={fmtDate(b.date)}
                >
                  {formatScaled(b.tokensSoldScaled)}
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-slate-300 tabular-nums whitespace-nowrap">
                  {formatScaled(b.receivedScaled, 4)}{" "}
                  <span className="text-slate-600">{b.received.asset}</span>
                </td>
                {/*
                  * The unit is printed on every row because it is not the same
                  * unit on every row: RH batches price in VIRTUAL, Base batches
                  * in WETH. A bare number here would read as comparable down
                  * the column, and it is not.
                  */}
                <td className="px-4 py-3 font-mono text-[11px] text-slate-400 tabular-nums whitespace-nowrap">
                  {formatScaled(b.avgPriceScaled, 4)}{" "}
                  <span className="text-slate-600">{b.received.asset}</span>
                </td>
                <td className="px-4 py-3">
                  <TxLink chain={b.chain} hash={b.txHash} />
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {b.swappedToVirt ? (
                    <TxLink chain={b.chain} hash={b.swappedToVirt.txHash} />
                  ) : b.chain === "base" ? (
                    <span className="font-mono text-[11px] text-[#F59E0B]">pending swap</span>
                  ) : (
                    <span className="font-mono text-[11px] text-slate-700" title="Robinhood Chain proceeds arrive as VIRTUAL — no swap needed">
                      —
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ══ Running totals + the split ═════════════════════════════════════ */}
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] p-6">
        <div className="grid gap-6 sm:grid-cols-2 mb-6">
          <div>
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500 mb-2">
              Raised on Robinhood Chain
            </div>
            <div className="text-2xl font-bold text-white tabular-nums">
              {formatScaled(t.virtRh, 4)} <span className="text-[#34D399] text-base">VIRT</span>
            </div>
            <div className="text-[12px] text-slate-600 mt-1">
              from {formatScaled(t.tokensSoldRh)} $BLUEAGENT
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500 mb-2">
              Raised on Base
            </div>
            <div className="text-2xl font-bold text-white tabular-nums">
              {formatScaled(t.wethBase, 4)} <span className="text-[#4FC3F7] text-base">WETH</span>
              <span className="text-slate-600 text-base"> → </span>
              {formatScaled(t.virtBase, 4)} <span className="text-[#4FC3F7] text-base">VIRT</span>
            </div>
            <div className="text-[12px] text-slate-600 mt-1">
              from {formatScaled(t.tokensSoldBase)} $BLUEAGENT
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-[#1A1A2E]">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500 mb-3">
            Current airdrop split
          </div>

          {t.splitKnown ? (
            <>
              <div className="flex items-baseline gap-4 flex-wrap mb-3">
                <div className="text-3xl font-bold tabular-nums" style={{ color: ACCENT.rh }}>
                  {fmtBps(t.splitRhBps)} <span className="text-sm text-slate-500">RH</span>
                </div>
                <div className="text-3xl font-bold tabular-nums" style={{ color: ACCENT.base }}>
                  {fmtBps(t.splitBaseBps)} <span className="text-sm text-slate-500">Base</span>
                </div>
              </div>
              <div className="flex h-2 rounded-full overflow-hidden bg-[#050508] mb-3">
                <div style={{ width: `${t.splitRhBps / 100}%`, background: ACCENT.rh }} />
                <div style={{ width: `${t.splitBaseBps / 100}%`, background: ACCENT.base }} />
              </div>
              <p className="text-[12px] text-slate-500 leading-relaxed">
                Provisional until selling completes. Computed as each chain&rsquo;s VIRT proceeds
                over the total, from the batches listed above and nothing else.
              </p>
            </>
          ) : (
            /*
             * Every Base batch so far is still awaiting its swap, so no VIRT
             * total exists on either side and there is no ratio to state. The
             * honest output is that there isn't one yet — not 0% / 100%.
             */
            <p className="text-[13px] text-slate-400 leading-relaxed">
              Not yet determined — no proceeds have settled in VIRT. The split is computed from
              VIRT totals, so it appears once the first batch settles.
            </p>
          )}

          {/*
           * A sold-but-unswapped Base batch has a known WETH value and an
           * UNKNOWN VIRT value. It is therefore excluded from the split rather
           * than counted at zero, and that exclusion is stated: silently
           * dropping it would understate Base's share of an allocation the page
           * is already publishing.
           */}
          {t.pendingSwapCount > 0 ? (
            <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "#F59E0B" }}>
              {t.pendingSwapCount} Base {t.pendingSwapCount === 1 ? "batch is" : "batches are"} sold
              but not yet swapped to VIRT. Until that swap settles the VIRT value is unknown, so{" "}
              {t.pendingSwapCount === 1 ? "it is" : "they are"} excluded from the split above — the
              Base share will rise when {t.pendingSwapCount === 1 ? "it lands" : "they land"}.
            </p>
          ) : null}
        </div>
      </div>

      <p className="mt-4 text-[12px] text-slate-500 leading-relaxed">
        All proceeds fund the $NEW launch pool. Every transaction is verifiable on the explorer.
        The final split locks when the last batch settles.
      </p>
    </section>
  );
}
