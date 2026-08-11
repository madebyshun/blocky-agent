import Link from "next/link";
import { DocHeader, H2, P, CodeBlock, Callout, CardGrid, Card, PrevNext } from "../_ui";

export const metadata = { title: "Quickstart — Blue Agent Docs" };

export default function Quickstart() {
  return (
    <article>
      <DocHeader
        eyebrow="Getting Started"
        title="Quickstart"
        lead="Install the CLI and run your first command in 60 seconds. Requires Node.js ≥ 18. No API key needed for core commands."
      />

      <H2 id="cli">1 · Install the CLI</H2>
      <CodeBlock title="@blueagent/cli" badge="CLI">{`# 1. install
$ npm install -g @blueagent/cli

# 2. install skill files (grounding knowledge)
$ blue init

# 3. run your first command
$ blue idea "DeFi protocol for Base"

# verify your setup
$ blue doctor`}</CodeBlock>

      <H2 id="ways-in">2 · Other ways in</H2>
      <CardGrid cols={2}>
        <Card title="Interactive TUI" color="#A78BFA">
          Run <code className="text-slate-300">blueagent</code> for an arrow-key menu over every command.
        </Card>
        <Card title="Blue Chat" color="#4FC3F7" href="/app/chat">
          No install — the fastest way in. Slash commands + live Hub tools, right in your browser.
        </Card>
      </CardGrid>

      <H2 id="mcp">3 · Load into your IDE (MCP)</H2>
      <P>Point Claude Code, Cursor, or Claude Desktop at the remote MCP server — nothing to install:</P>
      <CodeBlock title="MCP config" badge="MCP">{`{
  "mcpServers": {
    "blue-agent": { "url": "https://blueagent.dev/api/mcp" }
  }
}`}</CodeBlock>

      <Callout title="What's next?">
        Explore the <Link href="/docs/commands" className="text-[#4FC3F7] underline">24 CLI commands</Link>,
        browse the <Link href="/docs/skills" className="text-[#4FC3F7] underline">40 skill files</Link>,
        or read how <Link href="/docs/credits" className="text-[#4FC3F7] underline">credits &amp; tiers</Link> work in Blue Chat.
      </Callout>

      <PrevNext current="/docs/quickstart" />
    </article>
  );
}
