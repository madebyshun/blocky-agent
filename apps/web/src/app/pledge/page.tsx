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
import Link from "next/link";
import Navbar from "@/components/Navbar";
import {
  RECEIVING_WALLET,
  PLEDGE_DEADLINE_ISO,
  WARNING_TEXT,
  CHAINS,
  CHAIN_KEYS,
} from "@/lib/pledge/config";
import PledgeClient, { CopyAddress } from "./PledgeClient";

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

const STEPS = [
  {
    n: "01",
    title: "Send from a wallet you control",
    body: "Transfer your old $BLUEAGENT to the address below on Base or Robinhood Chain. Never send from an exchange account — the tokens would arrive from the exchange's wallet, not yours, and the pledge could not be credited to you.",
  },
  {
    n: "02",
    title: "Your transfer appears in the ledger",
    body: "This page reads Transfer events into the receiving wallet directly from the chain. Your row shows up on the next refresh, with the transaction hash linked to the block explorer so you can check it yourself.",
  },
  {
    n: "03",
    title: "Allocations are published before distribution",
    body: "When the window closes, the final allocation table is published from this same ledger. The claim contract is built separately and does not exist yet — see the warning above.",
  },
];

/**
 * A countdown reads as a commitment, so none is rendered until a real date
 * exists. `PLEDGE_DEADLINE_ISO = null` is the honest state, not a placeholder
 * to be filled with a plausible-looking date.
 */
function deadlineLabel(): { value: string; note: string } {
  if (!PLEDGE_DEADLINE_ISO) {
    return {
      value: "To be announced",
      note: "No closing date has been set. When one is, it will be announced here and on X before any clock starts.",
    };
  }
  const d = new Date(PLEDGE_DEADLINE_ISO);
  return {
    value: d.toISOString().replace("T", " ").slice(0, 16) + " UTC",
    note: "Transfers received after this time may not be included in the allocation table.",
  };
}

export default function PledgePage() {
  const deadline = deadlineLabel();

  return (
    <div className="min-h-screen bg-[#050508] text-white">
      <Navbar />

      <div className="pt-14">
        {/* ══ Warning — first thing on the page, before the address ══════════ */}
        <section className="max-w-3xl mx-auto px-6 pt-10">
          <div
            className="rounded-2xl border p-6"
            style={{ borderColor: "#F59E0B40", background: "#F59E0B0D" }}
          >
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-[#F59E0B] mb-3">
              Read this before you send anything
            </div>
            <p className="text-[15px] text-slate-200 leading-relaxed">{WARNING_TEXT}</p>
          </div>
        </section>

        {/* ══ Hero ══════════════════════════════════════════════════════════ */}
        <section className="max-w-3xl mx-auto px-6 pt-12">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
            Token migration <span className="text-[#4FC3F7]">pledge</span>
          </h1>
          <p className="text-[15px] text-slate-400 leading-relaxed mb-8 max-w-2xl">
            Holders of the old $BLUEAGENT can pledge it toward the relaunch by transferring it to the
            wallet below. This page does not hold, sign, or move anything — it reads the chain and
            publishes every transfer it finds, with the transaction hash for each one.
          </p>

          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] p-6 mb-6">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
              <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
                Receiving wallet
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
              The same address on both chains. Verify it against the two explorer links above before
              sending — do not trust an address pasted anywhere else, including a message claiming to
              be from us.
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
              Pledge window closes
            </div>
            <div className="text-lg font-bold text-white">{deadline.value}</div>
            <div className="text-[12px] text-slate-500 mt-1 leading-relaxed">{deadline.note}</div>
          </div>
        </section>

        {/* ══ How it works ══════════════════════════════════════════════════ */}
        <section className="max-w-3xl mx-auto px-6 py-16">
          <h2 className="text-xl font-bold text-white mb-6">How it works</h2>
          <div className="space-y-4">
            {STEPS.map((s) => (
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
            <p>
              <span className="text-slate-300">Claiming happens later, at{" "}
              <Link href="/claim" className="text-[#4FC3F7] hover:underline">/claim</Link>.</span>{" "}
              That page is up now and deliberately has no wallet connection on it yet — so &ldquo;the
              site is asking me to connect in order to claim&rdquo; is, until it is announced, itself
              the sign that you are not on our site.
            </p>
            <p>
              More about the project: <Link href="/about" className="text-[#4FC3F7] hover:underline">About</Link>
              {" · "}
              <Link href="/docs" className="text-[#4FC3F7] hover:underline">Docs</Link>
              {" · "}
              <Link href="/soul" className="text-[#4FC3F7] hover:underline">Soul</Link>
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
