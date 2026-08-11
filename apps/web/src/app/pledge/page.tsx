/**
 * /pledge — the token migration pledge page.
 *
 * Deliberately a SERVER component. Everything a holder needs in order to decide
 * — the risk disclosure, the receiving address, the steps, the deadline status
 * — renders without JavaScript. Only the live ledger below is client-side. If
 * the ledger fails to load, the page still tells the truth; if the warning
 * depended on a hydrated component, a JS error could show someone an address to
 * send tokens to with no disclosure attached to it.
 *
 * ─── What this page is allowed to do ────────────────────────────────────────
 * Read the chain and publish what it finds. Nothing here connects a wallet,
 * requests a signature, or builds a transaction — the transfer is made by the
 * holder, from their own wallet, to an address printed here in full. That is
 * also why there is no "Pledge now" button: a button implies this site performs
 * the action, and it does not.
 */
import type { Metadata } from "next";
import {
  RECEIVING_WALLET,
  PLEDGE_DEADLINE_ISO,
  WARNING_TEXT,
  WARNING_TEXT_CLOSED,
  isPledgeWindowClosed,
  CHAINS,
  CHAIN_KEYS,
} from "@/lib/pledge/config";
import PledgeClient, { CopyAddress } from "./PledgeClient";
import SaleBatches from "./SaleBatches";

/**
 * Rendered per request, NOT prerendered — the one thing on this page that
 * changes without a deploy is whether the window is still open.
 *
 * The alternative was ISR (`revalidate = N`), and it is wrong here for a
 * specific reason rather than a general one: Next serves the STALE page while
 * it regenerates, and regeneration is triggered BY a request. So the first
 * visitor after the deadline is guaranteed to receive the pre-deadline page —
 * the one that says the window is open and prints an address to send to. The
 * person the closed state exists to protect is exactly the person ISR fails.
 *
 * Client-side date checking was rejected for the reason in the header comment:
 * the disclosure has to survive JavaScript not running.
 *
 * The cost is a function invocation per view. This page renders constants and a
 * committed JSON file with no network calls in the server path — the ledger
 * fetches itself client-side — so that invocation is cheap, and correctness at
 * the boundary is not something to trade for a cache hit.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Token migration pledge — Blue Agent",
  description:
    "Pledge old $BLUEAGENT for the relaunch. Every transfer into the receiving wallet is published here with its transaction hash, on Base and Robinhood Chain.",
  openGraph: {
    title: "Token migration pledge — Blue Agent",
    description:
      "A public, verifiable ledger of every pledged transfer. Read from the chain, checkable on the explorer.",
    url: "https://blueagent.dev/pledge",
  },
};

/**
 * Written in two tenses rather than one, because step 01 is an INSTRUCTION to
 * make an irreversible transfer. Leaving it in the imperative under a banner
 * that says the window is shut would leave the page arguing with itself, and a
 * reader resolving that contradiction in the wrong direction loses tokens.
 */
function steps(closed: boolean) {
  return [
    closed
      ? {
          n: "01",
          title: "Pledging has ended",
          body: "The window for transferring old $BLUEAGENT has passed. Nothing sent to the address below is counted now — the address stays published so that people who did pledge can verify where their tokens went.",
        }
      : {
          n: "01",
          title: "Send from a wallet you control",
          body: "Transfer your old $BLUEAGENT to the address below on Base or Robinhood Chain. Never send from an exchange account — the tokens would arrive from the exchange's wallet, not yours, and the pledge could not be credited to you.",
        },
    closed
      ? {
          n: "02",
          title: "Every pledge is in the ledger",
          body: "This page reads Transfer events into the receiving wallet directly from the chain. Every transfer that landed before the deadline is listed below with its transaction hash linked to the block explorer, so you can check it yourself.",
        }
      : {
          n: "02",
          title: "Your transfer appears in the ledger",
          body: "This page reads Transfer events into the receiving wallet directly from the chain. Your row shows up on the next refresh, with the transaction hash linked to the block explorer so you can check it yourself.",
        },
    {
      n: "03",
      title: "Allocations are published before distribution",
      body: closed
        ? "The final allocation table is published from this same ledger. The claim contract is built separately and does not exist yet — see the notice above."
        : "When the window closes, the final allocation table is published from this same ledger. The claim contract is built separately and does not exist yet — see the warning above.",
    },
  ];
}

/**
 * A countdown reads as a commitment, so none is rendered until a real date
 * exists. `PLEDGE_DEADLINE_ISO = null` is the honest state, not a placeholder
 * to be filled with a plausible-looking date.
 */
function deadlineLabel(closed: boolean): { label: string; value: string; note: string } {
  if (!PLEDGE_DEADLINE_ISO) {
    return {
      label: "Pledge window closes",
      value: "To be announced",
      note: "No closing date has been set. When one is, it will be announced here and on X before any clock starts.",
    };
  }
  const d = new Date(PLEDGE_DEADLINE_ISO);
  const value = d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return closed
    ? {
        label: "Pledge window closed",
        value,
        // Past tense and unhedged. Before the deadline "may not be included"
        // was honest about a transfer still in flight; afterwards there is
        // nothing left to hedge, and hedging would read as an opening.
        note: "This window has passed. Transfers received after this time are not included in the allocation table.",
      }
    : {
        label: "Pledge window closes",
        value,
        note: "Transfers received after this time may not be included in the allocation table.",
      };
}

export default function PledgePage() {
  const closed = isPledgeWindowClosed();
  const deadline = deadlineLabel(closed);

  return (
    <div className="min-h-screen bg-[#050508] text-white">
      {/*
       * Brand mark only — deliberately not a nav, and not a link. Someone about
       * to make an irreversible transfer should not be one stray click away from
       * the page that carries the warning. The mark stays because a page asking
       * you to verify you are on the real site cannot be an unbranded one.
       */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-[#1A1A2E] bg-[#050508]/90 backdrop-blur-xl">
        <div className="flex items-center h-14 px-6 sm:px-10">
          <div className="flex items-center gap-2.5">
            <img src="/logomark.svg" alt="" className="h-6 w-6 rounded-md" />
            <span className="font-mono font-bold text-white tracking-widest text-[13px]">
              BLUE<span className="text-[#4FC3F7]">AGENT</span>
            </span>
          </div>
        </div>
      </header>

      <div className="pt-14">
        {/*
          * ══ Warning — first thing on the page, before the address ══════════
          * Red once closed, amber while open. The colour is doing work here: a
          * reader who has seen this page before recognises the block by its
          * colour and may not re-read it, so the closed state has to be
          * distinguishable at a glance, not only on a careful read.
          */}
        <section className="max-w-3xl mx-auto px-6 pt-10">
          <div
            className="rounded-2xl border p-6"
            style={
              closed
                ? { borderColor: "#EF444460", background: "#EF44440F" }
                : { borderColor: "#F59E0B40", background: "#F59E0B0D" }
            }
          >
            <div
              className="font-mono text-[11px] tracking-[0.2em] uppercase mb-3"
              style={{ color: closed ? "#EF4444" : "#F59E0B" }}
            >
              {closed ? "The pledge window is closed" : "Read this before you send anything"}
            </div>
            <p className="text-[15px] text-slate-200 leading-relaxed">
              {closed ? WARNING_TEXT_CLOSED : WARNING_TEXT}
            </p>
          </div>
        </section>

        {/* ══ Hero ══════════════════════════════════════════════════════════ */}
        <section className="max-w-3xl mx-auto px-6 pt-12">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
            Token migration <span className="text-[#4FC3F7]">pledge</span>
          </h1>
          <p className="text-[15px] text-slate-400 leading-relaxed mb-8 max-w-2xl">
            {closed
              ? "The window for pledging old $BLUEAGENT toward the relaunch has closed. This page does not hold, sign, or move anything — it reads the chain and publishes every transfer it found, with the transaction hash for each one."
              : "Holders of the old $BLUEAGENT can pledge it toward the relaunch by transferring it to the wallet below. This page does not hold, sign, or move anything — it reads the chain and publishes every transfer it finds, with the transaction hash for each one."}
          </p>

          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] p-6 mb-6">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
              <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
                Receiving wallet
                {/*
                  * Attached to the label, not placed under the address. The
                  * address is the most copyable thing on the page and the part
                  * most likely to be screenshotted or pasted somewhere else; a
                  * notice that travels next to the heading is harder to crop
                  * away from it than a paragraph sitting below.
                  */}
                {closed ? (
                  <span
                    className="ml-2 not-italic px-2 py-0.5 rounded-md"
                    style={{ background: "#EF444418", color: "#EF4444" }}
                  >
                    Closed — do not send
                  </span>
                ) : null}
              </span>
              <div className="flex items-center gap-2">
                {CHAIN_KEYS.map((c) => (
                  <a
                    key={c}
                    href={CHAINS[c].explorerAddress(RECEIVING_WALLET)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[10px] px-2 py-1 rounded-md border border-[#1A1A2E] text-slate-500 hover:text-white hover:border-[#4FC3F740] transition-all"
                  >
                    {CHAINS[c].shortLabel} ↗
                  </a>
                ))}
              </div>
            </div>

            <CopyAddress address={RECEIVING_WALLET} />

            <p className="mt-4 text-[12px] text-slate-500 leading-relaxed">
              {closed ? (
                <>
                  The same address on both chains. It stays published so pledgers can audit the
                  ledger against the explorer — not as somewhere to send to. Anyone telling you this
                  window is still open, or offering a &ldquo;late pledge&rdquo;, is not us.
                </>
              ) : (
                <>
                  The same address on both chains. Verify it against the two explorer links above
                  before sending — do not trust an address pasted anywhere else, including a message
                  claiming to be from us.
                </>
              )}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 mb-4">
            {CHAIN_KEYS.map((c) => {
              const cfg = CHAINS[c];
              return (
                <div key={c} className="rounded-xl border border-[#1A1A2E] bg-[#0a0a10] p-4">
                  <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500 mb-2">
                    {cfg.label} · chain {cfg.chainId}
                  </div>
                  <a
                    href={cfg.explorerAddress(cfg.token.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[11px] text-slate-400 hover:text-[#4FC3F7] break-all transition-colors"
                  >
                    {cfg.token.address}
                  </a>
                  <div className="font-mono text-[10px] text-slate-600 mt-2">
                    {cfg.token.symbol} · {cfg.token.decimals} decimals
                  </div>
                </div>
              );
            })}
          </div>

          <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a10] p-4">
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500 mb-1.5">
              {deadline.label}
            </div>
            <div className="text-lg font-bold text-white">{deadline.value}</div>
            <div className="text-[12px] text-slate-500 mt-1 leading-relaxed">{deadline.note}</div>
          </div>
        </section>

        {/* ══ How it works ══════════════════════════════════════════════════ */}
        <section className="max-w-3xl mx-auto px-6 py-16">
          <h2 className="text-xl font-bold text-white mb-6">How it works</h2>
          <div className="space-y-4">
            {steps(closed).map((s) => (
              <div key={s.n} className="flex gap-4 rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] p-5">
                <div className="font-mono text-[11px] text-[#4FC3F7] pt-0.5 shrink-0">{s.n}</div>
                <div>
                  <div className="font-bold text-white mb-1.5">{s.title}</div>
                  <p className="text-[13px] text-slate-400 leading-relaxed">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ══ Live ledger ═══════════════════════════════════════════════════ */}
        <section className="max-w-5xl mx-auto px-6 pb-16">
          <PledgeClient />
        </section>

        {/*
          * ══ Sale batches ═════════════════════════════════════════════════
          * Renders nothing until the first batch is sold, so this is invisible
          * while the pledge window is open. Below the ledger deliberately: what
          * came in is the fact, what was sold out of it is the consequence.
          */}
        <SaleBatches />

        {/* ══ Footer ════════════════════════════════════════════════════════ */}
        <section className="max-w-3xl mx-auto px-6 pb-24 border-t border-[#1A1A2E] pt-10">
          <div className="space-y-3 text-[13px] text-slate-500 leading-relaxed">
            <p>
              <span className="text-slate-300">Sent the wrong token, or sent by mistake?</span> Reach
              out on{" "}
              <a
                href="https://x.com/blueagent_"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#4FC3F7] hover:underline"
              >
                X @blueagent_
              </a>
              . Anything that is not old $BLUEAGENT is returned on request. A pledged $BLUEAGENT
              transfer is not reversible — that is what the warning above means.
            </p>
            <p>
              The full record is downloadable as{" "}
              <a href="/api/pledge?format=csv" className="text-[#4FC3F7] hover:underline">
                CSV
              </a>{" "}
              and readable as{" "}
              <a href="/api/pledge" className="text-[#4FC3F7] hover:underline">
                JSON
              </a>
              . Neither requires an account. Every row can be checked against the block explorer
              without trusting this page.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
