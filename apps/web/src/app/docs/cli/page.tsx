import Link from "next/link";
import { DocHeader, H2, P, CodeBlock, Callout, CardGrid, Card, PrevNext } from "../_ui";

export const metadata = { title: "Blue CLI — Blue Agent Docs" };

const ENV = [
  { key: "BANKR_API_KEY",        desc: "Bankr LLM key — required for AI-backed commands (idea/build/audit/ship/raise). Core scaffolding works without it." },
  { key: "BLUE_AGENT_SKILLS_DIR", desc: "Override the skills directory. Takes priority over ~/.blue-agent/skills/ and the bundled skills." },
];

export default function CliDoc() {
  return (
    <article>
      <DocHeader
        eyebrow="CLI Reference"
        title="Blue CLI"
        lead="The @blueagent/cli package ships two binaries: blue for direct commands and blueagent for an interactive TUI. Requires Node.js ≥ 18. Published on npm."
      />

      <H2 id="install">Install</H2>
      <CodeBlock title="@blueagent/cli" badge="npm">{`$ npm install -g @blueagent/cli

# verify
$ blue doctor`}</CodeBlock>

      <H2 id="binaries">Two ways to run</H2>
      <CardGrid cols={2}>
        <Card title="blue — direct commands" color="#4FC3F7">
          One-shot commands for scripts and CI: <code className="text-slate-300">blue idea &quot;…&quot;</code>,{" "}
          <code className="text-slate-300">blue audit &quot;…&quot;</code>. See <Link href="/docs/commands" className="text-[#4FC3F7] underline">Commands</Link>.
        </Card>
        <Card title="blueagent — interactive TUI" color="#A78BFA">
          A full-screen menu — arrow keys to browse and run every command without memorizing flags.
        </Card>
      </CardGrid>
      <Callout color="#34D399" title="No install? Use Blue Chat">
        <a href="/app/chat" className="text-[#34D399] underline">Blue Chat</a> runs the same commands in your browser — slash commands and live Hub tools, nothing to install.
      </Callout>

      <H2 id="setup">First-run setup</H2>
      <CodeBlock title="setup">{`# install skill files (grounding knowledge) to ~/.blue-agent/skills/
$ blue init

# scaffold a new Base project
$ blue new my-app --template base-token   # base-agent | base-x402 | base-token

# health-check an existing project
$ blue validate ./my-project`}</CodeBlock>

      <H2 id="config">Configuration</H2>
      <P>Configure the CLI with environment variables:</P>
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden divide-y divide-[#1A1A2E] my-5">
        {ENV.map((e) => (
          <div key={e.key} className="px-5 py-3.5">
            <code className="font-mono text-[12px] text-[#4FC3F7] block mb-1">{e.key}</code>
            <p className="font-mono text-[11px] text-slate-500 leading-relaxed">{e.desc}</p>
          </div>
        ))}
      </div>
      <Callout title="Skill load order">
        <code className="text-slate-300">BLUE_AGENT_SKILLS_DIR</code> → <code className="text-slate-300">~/.blue-agent/skills/</code> → bundled skills. See <Link href="/docs/skills" className="text-[#4FC3F7] underline">Skills</Link>.
      </Callout>

      <PrevNext current="/docs/cli" />
    </article>
  );
}
