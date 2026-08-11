import Link from "next/link";
import { DocHeader, H2, P, PrevNext, Callout } from "../_ui";
import { TIERS, CORE_COMMANDS } from "../_data";

export const metadata = { title: "Credits & Tiers — Blue Agent Docs" };

export default function CreditsDoc() {
  return (
    <article>
      <DocHeader
        eyebrow="Platform"
        title="Credits & Tiers"
        lead="Two rails, no subscription. Blue Chat runs on free daily credits — a bucket for everyone, bigger the moment you connect any wallet, topped up with USDC credit packs. Hub tools are pay-per-call in USDC on Base."
      />

      <H2 id="chat-credits">Blue Chat — credits</H2>
      <P>
        Every Blue Chat message spends credits. Start on the Guest tier with no wallet — connect any
        wallet (no token needed) and your daily allowance jumps to 500. Heavier modes
        (Web Search, Deep Think) spend more per message; your allowance is per day.
      </P>
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden my-5">
        {TIERS.map((r, i) => (
          <div key={r.tier} className={`flex items-center justify-between px-5 py-3.5 ${i > 0 ? "border-t border-[#1A1A2E]" : ""}`}>
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: r.color }} />
              <span className="font-bold text-sm shrink-0" style={{ color: r.color }}>{r.tier}</span>
              <span className="font-mono text-[11px] text-slate-600 truncate">{r.need}</span>
            </div>
            <span className="font-mono text-[11px] text-slate-300 shrink-0">{r.perk}</span>
          </div>
        ))}
      </div>
      <P>
        No token to hold, nothing to lock. Connect any wallet for the full daily allowance — need more
        than the daily bucket? Top up with a USDC credit pack on Base and it adds to a pool that carries
        over.
      </P>

      <H2 id="hub-tools">Hub tools — x402</H2>
      <P>
        The Hub&apos;s tools are billed per call in USDC on Base — no credits, no subscription, no
        API key. You pay only for the calls you make, at a price fixed per tool. These five core
        commands are the headline:
      </P>
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden my-5">
        {CORE_COMMANDS.map((c, i) => (
          <div key={c.cmd} className={`flex items-center justify-between px-5 py-3.5 ${i > 0 ? "border-t border-[#1A1A2E]" : ""}`}>
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />
              <span className="font-mono font-bold text-sm shrink-0" style={{ color: c.color }}>blue {c.cmd}</span>
              <span className="font-mono text-[11px] text-slate-600 truncate">{c.desc}</span>
            </div>
            <span className="font-mono text-[11px] text-slate-300 shrink-0">{c.price}</span>
          </div>
        ))}
      </div>
      <P>
        The full catalog spans from $0.01 per call. Browse every pay-per-call tool under{" "}
        <Link href="/docs/x402" className="text-[#4FC3F7] underline">x402 Tools</Link>.
      </P>

      <Callout color="#34D399" title="No credits needed for tools">
        Chat credits and Hub payments are separate rails. Tools settle in USDC on Base via x402
        (EIP-3009, Coinbase CDP facilitator) — you never spend chat credits on a tool call, and you
        never need credits or an API key to hit the endpoint.
      </Callout>

      <PrevNext current="/docs/credits" />
    </article>
  );
}
