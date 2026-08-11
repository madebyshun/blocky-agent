import { DocHeader, H2, P, CodeBlock, Callout, PrevNext } from "../_ui";
import { PACKAGES } from "../_data";

export const metadata = { title: "For Developers — Blue Agent Docs" };

export default function DevelopDoc() {
  return (
    <article>
      <DocHeader
        eyebrow="Platform"
        title="For Developers"
        lead="All packages are open source (MIT). Fork the monorepo, run it locally, add your own skills, and contribute."
      />

      <H2 id="run-locally">Run locally</H2>
      <CodeBlock title="run locally" badge="dev">{`$ git clone https://github.com/madebyshun/blue-agent
$ npm install
$ npm run dev`}</CodeBlock>

      <H2 id="add-skill">Add a skill file</H2>
      <P>
        Drop a <code className="text-slate-300">.md</code> file in <code className="text-slate-300">skills/</code> and register it in{" "}
        <code className="text-[#4FC3F7]">packages/core/src/registry.ts</code>. The runtime resolves skills in this order:
      </P>
      <CodeBlock title="skill load order">{`BLUE_AGENT_SKILLS_DIR  →  ~/.blue-agent/skills/  →  monorepo skills/`}</CodeBlock>

      <H2 id="packages">Packages</H2>
      <P>All <code className="text-slate-300">@blueagent/*</code> packages are published on npm — install only what you need:</P>
      <CodeBlock title="install from npm" badge="npm">{`$ npm install -g @blueagent/cli     # CLI + TUI
$ npm install @blueagent/x402        # x402 client SDK
$ npm install @blueagent/sdk         # unified SDK
$ npm install @blueagent/agentkit    # Coinbase AgentKit plugin`}</CodeBlock>
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-6 my-5 space-y-5">
        {PACKAGES.map((group) => (
          <div key={group.label}>
            <div className="font-mono text-[10px] tracking-widest mb-2" style={{ color: group.color }}>{group.label}</div>
            <div className="space-y-1.5">
              {group.items.map((p) => (
                <div key={p.pkg} className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-4">
                  <code className="font-mono text-sm shrink-0 sm:min-w-[200px]" style={{ color: group.color }}>{p.pkg}</code>
                  <span className="font-mono text-[11px] text-slate-500">{p.desc}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Callout title="Hard rules for contributors">
        Base chain only (8453). Use the Virtuals / Venice LLM gateway for all AI calls. Never hallucinate contract addresses — verify on Basescan.
        Business logic lives in <code className="text-slate-300">packages/</code>, not the app.
      </Callout>

      <PrevNext current="/docs/develop" />
    </article>
  );
}
