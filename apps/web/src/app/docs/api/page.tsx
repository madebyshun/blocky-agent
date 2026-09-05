import Link from "next/link";
import { DocHeader, H2, P, CodeBlock, Callout, CardGrid, Card, PrevNext } from "../_ui";

export const metadata = { title: "API Reference — Blue Agent Docs" };

export default function ApiDoc() {
  return (
    <article>
      <DocHeader
        eyebrow="Platform"
        title="API Reference"
        lead="112 x402 endpoints on blueagent.dev. Pay per call in USDC on Base — no API keys, no subscription, no signup. Every Blue command and Hub tool is reachable over HTTP."
      />

      <H2 id="base-url">Base URL</H2>
      <CodeBlock title="base url">{`https://blueagent.dev/api/x402`}</CodeBlock>
      <P>
        Machine-readable catalog:{" "}
        <a href="https://blueagent.dev/.well-known/openapi.json" className="text-[#4FC3F7] underline">/.well-known/openapi.json</a>.
      </P>

      <H2 id="auth">Authentication — x402</H2>
      <P>
        There are no keys. A request to a paid endpoint returns <code className="text-slate-300">402 Payment Required</code> with the price
        and payment details; your client pays the exact amount in USDC on Base and retries. The call then completes. Agents and apps pay automatically.
      </P>

      <H2 id="call">Calling an endpoint</H2>
      <CodeBlock title="with the x402 client" badge="recommended">{`import { createX402Client } from "@blueagent/x402";

const client = createX402Client({ wallet }); // pays 402s for you
const res = await client.post("https://blueagent.dev/api/x402/blue-idea", {
  prompt: "DeFi protocol for Base",
});
console.log(res.data);`}</CodeBlock>

      <CodeBlock title="raw HTTP (handle 402 yourself)">{`# 1. first call returns 402 with payment requirements
$ curl -i https://blueagent.dev/api/x402/blue-idea \\
    -H "Content-Type: application/json" \\
    -d '{"prompt":"DeFi protocol for Base"}'

# 2. pay the quoted USDC on Base, then retry with the payment header`}</CodeBlock>

      <H2 id="surfaces">Same tools, every surface</H2>
      <CardGrid cols={3}>
        <Card title="API" color="#fbbf24" href="https://blueagent.dev/.well-known/openapi.json">Direct HTTP — this reference.</Card>
        <Card title="MCP" color="#4FC3F7" href="/docs/mcp">In your IDE via the MCP server.</Card>
        <Card title="Hub" color="#A78BFA" href="/hub">Point-and-click in the Hub UI.</Card>
      </CardGrid>

      <Callout color="#fbbf24" title="Catalog">
        Discover every endpoint with <code className="text-[#4FC3F7]">blue-registry</code>, or browse{" "}
        <a href="https://blueagent.dev/.well-known/openapi.json" className="text-[#fbbf24] underline">the OpenAPI spec</a>. Pricing lives in{" "}
        <Link href="/docs/x402" className="text-[#fbbf24] underline">x402 Tools</Link>.
      </Callout>

      <PrevNext current="/docs/api" />
    </article>
  );
}
