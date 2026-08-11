/**
 * /claim — the $NEW claim page.
 *
 * A SERVER component, and the interesting part is what it does NOT do.
 *
 * While the flag is off this file renders text and nothing else: no wallet
 * connect, no button, no contract address — and, the part that actually
 * matters, none of the claim UI is in the JavaScript the browser downloads.
 * "Hidden behind a flag" and "not shipped to the browser" are different
 * properties, and only the second one is worth anything here; see
 * `lib/claim/config.ts` for why the absence of a Connect button IS the security
 * posture of this page before launch.
 *
 * Getting the second property took a specific trick — `./ClaimGate` documents
 * it, and `scripts/claim-bundle-test.ts` keeps it from silently regressing.
 *
 * The anti-scam warning renders identically in both states, from the same
 * constant, above everything else — including above the claim UI once it is
 * live. It is the one sentence that stays true on both sides of launch day.
 */
import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import ClaimGate from "./ClaimGate";
import { SCAM_WARNING } from "@/lib/claim/config";

export const metadata: Metadata = {
  title: "Claim $NEW — Blue Agent",
  description:
    "The official $NEW claim page for the $BLUEAGENT migration. Claiming opens only after the final allocation table is published. Any claim link circulating before then is a scam.",
  openGraph: {
    title: "Claim $NEW — Blue Agent",
    description:
      "The only address the $NEW claim ever runs at. We will never DM you a claim link.",
    url: "https://blueagent.dev/claim",
  },
};

const WHAT_HAPPENS = [
  {
    n: "01",
    title: "The pledge window closes",
    body: "Until it does, pledges keep arriving and the table cannot be final. Every transfer is already public on /pledge, read from the chain, with its transaction hash.",
  },
  {
    n: "02",
    title: "The allocation table is published",
    body: "A CSV of every wallet and its $NEW amount, plus a single 32-byte merkle root committing to exactly that file. Check your own row before anything is deployed — that is the point of publishing it first.",
  },
  {
    n: "03",
    title: "The claim contract is deployed and funded",
    body: "Its address and its root are printed on this page in full, both linked to the block explorer. If the root on the contract does not match the published table, this page refuses to show a claim button at all.",
  },
  {
    n: "04",
    title: "Claiming opens here",
    body: "You connect the wallet that holds the allocation and send one transaction from it. This site never holds keys, never signs for you, and never asks you to send anything first. Claiming costs nothing but gas.",
  },
];

export default function ClaimPage() {
  return (
    <div className="min-h-screen bg-[#050508] text-white">
      <Navbar />

      <div className="pt-14">
        {/* ══ Anti-scam warning — above everything, in both states ═══════════ */}
        <section className="max-w-3xl mx-auto px-6 pt-10">
          <div
            className="rounded-2xl border p-6"
            style={{ borderColor: "#F59E0B40", background: "#F59E0B0D" }}
          >
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-[#F59E0B] mb-3">
              Read this before you click anything
            </div>
            <p className="text-[15px] text-slate-200 leading-relaxed">{SCAM_WARNING}</p>
          </div>
        </section>

        {/* ══ Hero ══════════════════════════════════════════════════════════ */}
        <section className="max-w-3xl mx-auto px-6 pt-12">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
            Claim <span className="text-[#4FC3F7]">$NEW</span>
          </h1>
          <p className="text-[15px] text-slate-400 leading-relaxed max-w-2xl">
            The final step of the $BLUEAGENT migration. Holders who pledged on{" "}
            <Link href="/pledge" className="text-[#4FC3F7] hover:underline">
              /pledge
            </Link>{" "}
            claim their $NEW from a contract that pays against a published allocation table and can
            do nothing else — no pause, no edits, no admin transfer.
          </p>
        </section>

        {/* ══ The gate ══════════════════════════════════════════════════════
            One decision, made at build time inside ClaimGate — see the long
            comment there for why this cannot be a ternary in this file. The
            gated-off notice below is server-rendered here and handed over as
            the fallback, so it costs the client bundle nothing. ═══════════ */}
        <section className="max-w-3xl mx-auto px-6 pt-10">
          <ClaimGate
            fallback={
              <>
                <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] p-6">
                  <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500 mb-3">
                    Claiming is not open
                  </div>
                  <p className="text-[15px] text-slate-200 leading-relaxed mb-4">
                    Claiming opens after the pledge window closes and the final allocation table is
                    published. It will be announced on this site and on{" "}
                    <a
                      href="https://x.com/blueagent_"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#4FC3F7] hover:underline"
                    >
                      X (@blueagent_)
                    </a>{" "}
                    first.
                  </p>
                  <p className="text-[13px] text-slate-500 leading-relaxed">
                    There is deliberately no wallet connection on this page yet. Until claiming
                    opens, any page asking you to connect a wallet to claim $NEW — including one
                    that looks exactly like this one — is not us.
                  </p>
                </div>

                <div className="mt-4 flex flex-wrap gap-3">
                  <Link
                    href="/pledge"
                    className="font-mono text-[12px] px-4 py-2.5 rounded-xl border border-[#4FC3F740] text-[#4FC3F7] hover:bg-[#4FC3F710] transition-all"
                  >
                    ← The pledge ledger
                  </Link>
                  <a
                    href="https://x.com/blueagent_"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[12px] px-4 py-2.5 rounded-xl border border-[#1A1A2E] text-slate-400 hover:text-white hover:border-slate-600 transition-all"
                  >
                    Announcements on X ↗
                  </a>
                </div>
              </>
            }
          />
        </section>

        {/* ══ What happens, in order ════════════════════════════════════════ */}
        <section className="max-w-3xl mx-auto px-6 py-16">
          <h2 className="text-xl font-bold text-white mb-2">How the claim will work</h2>
          <p className="text-[13px] text-slate-500 leading-relaxed mb-6 max-w-2xl">
            In this order, with no step skipped. No dates are given here because none have been
            decided — a page that invents a date is a page you should not trust with the rest.
          </p>
          <div className="space-y-4">
            {WHAT_HAPPENS.map((s) => (
              <div
                key={s.n}
                className="flex gap-4 rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] p-5"
              >
                <div className="font-mono text-[11px] text-[#4FC3F7] pt-0.5 shrink-0">{s.n}</div>
                <div>
                  <div className="font-bold text-white mb-1.5">{s.title}</div>
                  <p className="text-[13px] text-slate-400 leading-relaxed">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ══ Footer ════════════════════════════════════════════════════════ */}
        <section className="max-w-3xl mx-auto px-6 pb-24 border-t border-[#1A1A2E] pt-10">
          <div className="space-y-3 text-[13px] text-slate-500 leading-relaxed">
            <p>
              <span className="text-slate-300">There is no support DM.</span> Nobody from Blue Agent
              will message you first about claiming. If someone does, it is not us, no matter whose
              name or picture is on the account. Questions go to{" "}
              <a
                href="https://x.com/blueagent_"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#4FC3F7] hover:underline"
              >
                X @blueagent_
              </a>{" "}
              in public.
            </p>
            <p>
              The pledge ledger is live now at{" "}
              <Link href="/pledge" className="text-[#4FC3F7] hover:underline">
                /pledge
              </Link>
              , downloadable as{" "}
              <a href="/api/pledge?format=csv" className="text-[#4FC3F7] hover:underline">
                CSV
              </a>
              . Every row in it can be checked against the block explorer without trusting this
              page — the allocation table will be publishable the same way.
            </p>
            <p>
              More about the project:{" "}
              <Link href="/about" className="text-[#4FC3F7] hover:underline">
                About
              </Link>
              {" · "}
              <Link href="/docs" className="text-[#4FC3F7] hover:underline">
                Docs
              </Link>
              {" · "}
              <Link href="/soul" className="text-[#4FC3F7] hover:underline">
                Soul
              </Link>
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
