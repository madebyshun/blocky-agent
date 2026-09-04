import Link from "next/link";
import { DocHeader, H2, P, CardGrid, Card, PrevNext, Callout } from "../_ui";
import { CHAT_MODELS, CHAT_CAPABILITIES } from "../_data";
import { AGENT_SKILLS, SKILL_PROVIDERS, PROVIDER_ICONS } from "@/app/chat/agent-skills";
import { HUB_SKILLS, SKILL_CATEGORIES, CATEGORY_ICONS } from "@/app/chat/hub-skills";
import { TOOL_COUNT } from "@/lib/agent-tools";

export const metadata = { title: "Blue Chat — Blue Agent Docs" };

const SLASH = [
  { cmd: "/idea",   d: "Turn a concept into a fundable brief (also: market-fit check)." },
  { cmd: "/build",  d: "Architecture, stack, and folder structure for a Base project." },
  { cmd: "/audit",  d: "Security review + deep analysis — reentrancy, oracle, MEV." },
  { cmd: "/ship",   d: "Deployment checklist, verification, and go-to-market brief." },
  { cmd: "/raise",  d: "Pitch narrative + investor memo for a fundraise." },
  { cmd: "/pick",   d: "Token pick signal — an asymmetric setup with a thesis." },
  { cmd: "/scan",   d: "Honeypot / contract safety scan on a token address." },
  { cmd: "/wallet", d: "Full on-chain portfolio breakdown for a wallet." },
  { cmd: "/launch", d: "Deploy a real token on Base via the Bankr launchpad — opens a form card." },
];

export default function BlueChatDoc() {
  return (
    <article>
      <DocHeader
        eyebrow="Products"
        title="Blue Chat"
        lead="Chat with an agent that knows Base. No install — pick a model, run slash commands, and call live skills and Hub tools right inside the conversation."
      />

      <P>
        Blue Chat is the fastest way in. Every message spends credits (see <Link href="/docs/credits" className="text-[#4FC3F7] underline">Credits &amp; Tiers</Link>),
        and you can start with no wallet. <Link href="/app/chat" className="text-[#4FC3F7] underline">Open Blue Chat →</Link>
      </P>

      <H2 id="models">Models — one preset per use-case</H2>
      <CardGrid cols={3}>
        {CHAT_MODELS.map((m) => (
          <div key={m.label} className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-4">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className="text-base">{m.icon}</span>
                <span className="font-bold text-sm" style={{ color: m.color }}>{m.label}</span>
              </div>
              <span className="font-mono text-[10px] text-slate-600">{m.cr}/msg</span>
            </div>
            <div className="font-mono text-[11px] text-slate-400">{m.model}</div>
            <div className="font-mono text-[10px] text-slate-600 mt-0.5">{m.note}</div>
          </div>
        ))}
      </CardGrid>

      <H2 id="slash">Slash commands</H2>
      <P>Type <code className="text-slate-300">/</code> in the composer to run a command inline — the same power as the CLI.</P>
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden divide-y divide-[#1A1A2E] my-5">
        {SLASH.map((s) => (
          <div key={s.cmd} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 px-5 py-3">
            <code className="font-mono text-[13px] text-[#4FC3F7] shrink-0 sm:w-24">{s.cmd}</code>
            <span className="font-mono text-[11px] text-slate-500 leading-relaxed">{s.d}</span>
          </div>
        ))}
      </div>

      <H2 id="capabilities">In-chat capabilities</H2>
      <CardGrid cols={2}>
        {CHAT_CAPABILITIES.map((c) => (
          <Card key={c.t} title={c.t} color="#A78BFA">{c.d}</Card>
        ))}
      </CardGrid>

      <H2 id="skills">Agent skills</H2>
      <P>
        Beyond chat, the agent can action live skills from three providers — just ask in plain language. Active skills run now;
        <span className="text-slate-300"> soon</span> ones are wiring up.
      </P>
      {SKILL_PROVIDERS.map((provider) => {
        const skills = AGENT_SKILLS.filter((s) => s.provider === provider);
        return (
          <div key={provider} className="my-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-base">{PROVIDER_ICONS[provider]}</span>
              {/* No per-provider hue: the header prints the provider's NAME, so a
                  colour keyed to that same name carries no information. */}
              <span className="font-mono text-[11px] tracking-widest uppercase text-slate-400">{provider}</span>
              <span className="font-mono text-[10px] text-slate-600">{skills.length} skills</span>
            </div>
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden divide-y divide-[#1A1A2E]">
              {skills.map((s) => (
                <div key={s.id} className="px-5 py-3">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-mono text-[12px] font-bold text-slate-200">{s.name}</span>
                    {s.status === "soon" && <span className="font-mono text-[8px] text-slate-500 border border-[#1A1A2E] rounded px-1 py-0.5">SOON</span>}
                  </div>
                  <p className="font-mono text-[11px] text-slate-500 leading-relaxed">{s.description}</p>
                  {s.trigger && <code className="font-mono text-[10px] text-slate-700">try: {s.trigger.trim()}</code>}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <H2 id="launch">Launch a token — live</H2>
      <P>
        Blue Chat can deploy a <strong className="text-slate-200">real token on Base</strong>, not just plan one. Type{" "}
        <code className="text-slate-300">/launch</code> (or ask &quot;launch a token&quot;) to open a form card — fill in name, ticker,
        description, logo, and website, then click <strong className="text-slate-200">Launch</strong> to deploy.
      </P>
      <CardGrid cols={2}>
        <Card title="Bankr launchpad" color="#F59E0B">Deploys via Bankr — Uniswap V4 pool, 100B fixed supply, <strong className="text-slate-200">gas sponsored by Bankr</strong>.</Card>
        <Card title="You confirm the deploy" color="#34D399">Nothing launches until you click Launch — it&apos;s a real, irreversible on-Base deploy. Returns Basescan, Uniswap & Bankr links.</Card>
        <Card title="Fee recipient" color="#A78BFA">Trading fees route to a wallet you choose; defaults to BlueAgent if left blank.</Card>
        <Card title="Showcase feed" color="#4FC3F7" href="/app/launches">Every token launched through Blue Chat appears live at <code className="text-slate-300">/app/launches</code> with market data.</Card>
      </CardGrid>
      <Callout color="#fbbf24" title="Plan before you launch">
        The <strong className="text-slate-200">Launch</strong> Hub tools below (readiness, launch advisor, distribution plan) help you
        prepare — then <code className="text-slate-300">/launch</code> ships it for real.
      </Callout>

      <H2 id="hub-tools">Hub tools in chat</H2>
      <P>The model can call {HUB_SKILLS.length} curated Hub tools for you, grouped by category:</P>
      <CardGrid cols={2}>
        {SKILL_CATEGORIES.map((cat) => {
          const tools = HUB_SKILLS.filter((s) => s.category === cat);
          return (
            <div key={cat} className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-base">{CATEGORY_ICONS[cat]}</span>
                <span className="font-bold text-sm text-white">{cat}</span>
                <span className="font-mono text-[10px] text-slate-600">{tools.length}</span>
              </div>
              <div className="font-mono text-[10px] text-slate-500 leading-relaxed">
                {tools.slice(0, 4).map((t) => t.name).join(" · ")}{tools.length > 4 ? " · …" : ""}
              </div>
            </div>
          );
        })}
      </CardGrid>

      <P>
        See the full {TOOL_COUNT}-tool catalog on the <Link href="/docs/blue-hub" className="text-[#4FC3F7] underline">Blue Hub</Link> page,
        with pricing in <Link href="/docs/x402" className="text-[#4FC3F7] underline">x402 Tools</Link>.
      </P>

      <PrevNext current="/docs/blue-chat" />
    </article>
  );
}
