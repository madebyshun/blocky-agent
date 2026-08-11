import { DocHeader, H2, P, CardGrid, PrevNext, Callout } from "../_ui";
import { X402_SUITE, CORE_COMMANDS } from "../_data";
import { TOOL_COUNT } from "@/lib/agent-tools";

export const metadata = { title: "x402 Tools — Blue Agent Docs" };

export default function X402Doc() {
  return (
    <article>
      <DocHeader
        eyebrow="Platform"
        title="x402 Tools"
        lead="Pay-per-call AI tools in USDC on Base — no keys, no subscription, no signup. The 5 core commands plus an extended blue-* suite, callable from the API, the Hub, or any MCP client."
      />

      <H2 id="how">How x402 works</H2>
      <P>
        x402 is an open payment standard: a tool returns <code className="text-slate-300">402 Payment Required</code>, your client
        pays the exact price in USDC on Base, and the call completes. No account, no monthly bill — you pay only for what you call,
        per request. BlueBank, agents, and any HTTP client can pay automatically.
      </P>

      <H2 id="core">5 core commands</H2>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 my-5">
        {CORE_COMMANDS.map((c) => (
          <div key={c.cmd} className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-4 text-center" style={{ boxShadow: `0 0 20px ${c.color}08` }}>
            <div className="font-mono text-sm font-bold mb-1" style={{ color: c.color }}>blue {c.cmd}</div>
            <div className="font-mono text-[10px] text-slate-600 mb-2">{c.desc}</div>
            <div className="font-mono text-[10px] text-slate-500 border border-[#1A1A2E] rounded-lg px-2 py-1">{c.price}</div>
          </div>
        ))}
      </div>

      <H2 id="suite">Extended blue-* suite</H2>
      <CardGrid cols={4}>
        {X402_SUITE.map((t) => (
          <div key={t.id} className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-4" style={{ boxShadow: `0 0 20px ${t.color}06` }}>
            <div className="flex items-center justify-between mb-2">
              <code className="font-mono text-[12px] font-bold" style={{ color: t.color }}>{t.id}</code>
              <span className="font-mono text-[9px] text-slate-500 border border-[#1A1A2E] rounded px-1.5 py-0.5">{t.price}</span>
            </div>
            <p className="font-mono text-[10px] text-slate-500 leading-relaxed">{t.desc}</p>
          </div>
        ))}
      </CardGrid>

      <Callout color="#fbbf24" title="Full catalog">
        {TOOL_COUNT} tools total. Discover the live catalog with <code className="text-[#4FC3F7]">blue-registry</code> or browse the OpenAPI spec at{" "}
        <a href="https://api.blueagent.dev/docs" className="text-[#fbbf24] underline">api.blueagent.dev/docs</a>.
      </Callout>

      <PrevNext current="/docs/x402" />
    </article>
  );
}
