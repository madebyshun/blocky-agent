import Link from "next/link";
import { DocHeader, H2, P, CardGrid, Card, PrevNext, Callout } from "./_ui";
import { STATS, PRODUCTS, FOUNDATION } from "./_data";
import { TOOL_COUNT } from "@/lib/agent-tools";

export const metadata = {
  title: "BlueAgent Docs — The onchain Agent OS",
  description: `BlueAgent: ${TOOL_COUNT} AI tools, Blue Chat, Blue Feed — built for Base builders and autonomous agents. x402 native, pay per call.`,
};

export default function DocsOverview() {
  return (
    <article>
      <DocHeader
        eyebrow="Introduction"
        title="Blue Agent"
        lead={`The onchain Agent OS. ${TOOL_COUNT} AI tools, Blue Chat, and live Base intelligence — built for builders and autonomous agents. x402 native, no API key needed.`}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[#1A1A2E] rounded-2xl overflow-hidden border border-[#1A1A2E] my-8">
        {STATS.map((s) => (
          <div key={s.label} className="bg-[#0d0d12] px-4 py-5 text-center">
            <div className="font-mono text-xl font-bold mb-1" style={{ color: s.color }}>{s.value}</div>
            <div className="font-mono text-[10px] text-slate-600 tracking-widest">{s.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      <H2>What is BlueAgent?</H2>
      <P>
        BlueAgent is an AI agent layer built on Base. It is not just a chatbot — it is a full economic actor:
        it holds a wallet, executes onchain transactions, and powers a growing ecosystem of tools and services.
        It is the <strong className="text-slate-200">onchain Agent OS</strong> — chat with AI agents, run {TOOL_COUNT} tools,
        and read live Base intelligence, all in one place.
      </P>

      <H2>The ecosystem</H2>
      <P>Four products, one agent — all built on Base, all x402 native.</P>
      <CardGrid cols={2}>
        {PRODUCTS.map((p) => (
          <Card key={p.name} title={p.name} color={p.color} href={p.link}>
            {p.desc}
            <span className="block mt-2 font-mono text-[10px]" style={{ color: p.color }}>{p.label}</span>
          </Card>
        ))}
      </CardGrid>

      <H2>Foundation</H2>
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-6 my-5">
        <div className="grid sm:grid-cols-3 gap-6">
          {FOUNDATION.map((f) => (
            <div key={f.label} className="flex items-start gap-3">
              <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: f.color }} />
              <div>
                <div className="font-bold text-white text-sm mb-0.5">{f.label}</div>
                <div className="font-mono text-[11px] text-slate-500">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Callout color="#34D399" title="New here?">
        Open <Link href="/app/chat" className="text-[#34D399] underline">Blue Chat</Link> for zero-install access, or browse the{" "}
        <Link href="/app/hub" className="text-[#34D399] underline">Hub</Link>&apos;s {TOOL_COUNT} pay-per-call tools. The{" "}
        <Link href="/docs/quickstart" className="text-[#34D399] underline">Quickstart</Link> gets you running in 60 seconds.
      </Callout>

      <PrevNext current="/docs" />
    </article>
  );
}
