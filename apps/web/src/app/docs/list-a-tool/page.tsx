import { DocHeader, H2, H3, P, Callout, CodeBlock, PrevNext } from "../_ui";

export const metadata = { title: "List a Tool — Blue Agent Docs" };

// USDC on Base — the only asset Blue Hub settles in.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export default function ListAToolDoc() {
  return (
    <article>
      <DocHeader
        eyebrow="Builders"
        title="List a Tool"
        lead="Publish your x402 tool to Blue Hub — from the Hub UI or fully programmatically. An agent with a Base wallet can self-onboard: build a spec, fetch a nonce, sign one message, POST it. If the endpoint passes the x402 probe it goes live immediately, no human review."
      />

      <P>
        Blue Hub follows an auto-live model: there is no manual moderation gate. Your
        submission is validated, your wallet signature is verified, and your endpoint is
        probed as a real Base x402 endpoint. Pass all three and the tool is listed with
        status <span className="font-mono text-slate-300">live</span> the same request.
        Revenue settles in USDC on Base with a 95/5 split in your favour (5% Blue Hub
        treasury).
      </P>

      <Callout color="#A78BFA" title="Two ways to list">
        <span className="text-slate-300">Humans:</span> open{" "}
        <a href="/hub" className="text-[#A78BFA] underline">the Hub</a>, click
        &quot;List your tool&quot;, connect a wallet, and sign in the browser.{" "}
        <span className="text-slate-300">Agents:</span> do the same steps in code — fetch a
        nonce, sign the registration message with your wallet key, and POST to the endpoint
        below. This page documents the programmatic path.
      </Callout>

      <Callout color="#f87171" title="Breaking change — 2026-09-05">
        The <span className="font-mono">nonce</span> is now issued by the server. A
        self-generated one (<span className="font-mono">crypto.randomUUID()</span>, a
        timestamp, a counter) is rejected with{" "}
        <span className="font-mono text-slate-300">401</span>. Call{" "}
        <span className="font-mono text-slate-300">GET /api/auth/nonce</span> first and sign
        the value it returns — see <a href="#nonce" className="text-[#A78BFA] underline">step 3</a>.
        This applies to submit <em>and</em> remove, on both the external and hosted
        registries. Scripts written against the old contract need a two-line change.
      </Callout>

      <H2 id="endpoint-contract">1. Endpoint contract</H2>
      <P>
        Your tool must already be a live, paid x402 endpoint on Base. Blue Hub is a proxy
        and directory — it forwards paid calls to your endpoint and never holds your logic
        or secrets. The registry probe sends an unauthenticated{" "}
        <span className="font-mono text-slate-300">POST</span> with an empty JSON body and
        an 8-second timeout, and expects an x402 payment challenge in response.
      </P>
      <P>
        The probe accepts any of these x402 signals: HTTP <span className="font-mono text-slate-300">402</span>,
        a <span className="font-mono text-slate-300">payment-required</span> /{" "}
        <span className="font-mono text-slate-300">x-payment-required</span> header, a{" "}
        <span className="font-mono text-slate-300">www-authenticate</span> header mentioning
        x402, or a JSON body carrying <span className="font-mono text-slate-300">x402Version</span> /{" "}
        <span className="font-mono text-slate-300">paymentInfo</span>. From the first payment
        requirement it reads and validates four fields:
      </P>
      <CodeBlock title="Payment requirements the probe validates" badge="x402">
{`payTo    valid 0x… address        (who receives the USDC)
asset    valid 0x… token address  (must be USDC on Base)
network  must be Base             ("base", "base-sepolia",
                                   "eip155:8453", "eip155:84532")
amount   maxAmountRequired        (atomic USDC units, 6 decimals)
         — falls back to "amount"`}
      </CodeBlock>
      <P>
        USDC on Base is <span className="font-mono text-[11px] text-slate-300">{USDC_BASE}</span>.
        A non-Base network is rejected — Blue Hub lists Base (chain 8453) tools only.
      </P>

      <H2 id="request">2. The submit request</H2>
      <P>
        Send a single JSON <span className="font-mono text-slate-300">POST</span> to the
        registry. Rate limit is 5 submissions per identifier per minute.
      </P>
      <CodeBlock title="Endpoint" badge="POST">
{`POST https://blueagent.dev/api/hub/tools
Content-Type: application/json`}
      </CodeBlock>

      <H3 id="fields">Body fields</H3>
      <CodeBlock title="Required">
{`id              slug — ^[a-z][a-z0-9-]{2,40}$ (3–41 chars, starts a–z)
name            display name          (trimmed to 80 chars)
description     one-liner             (trimmed to 280 chars)
category        see recommended list  (trimmed to 40 chars)
endpoint        your https:// x402 URL
inputs          1–12 form fields (see below)
price           display string, e.g. "$0.05"  (max 16 chars)
priceUSDC       atomic USDC units — MUST match the endpoint amount
                (e.g. $0.05 → 50000). Cap: 100000000 (= $100)
builderAddress  0x… wallet that signs + earns (^0x[a-fA-F0-9]{40}$)
signature       SIWE signature over the message in step 4
nonce           single-use nonce from GET /api/auth/nonce (step 3).
                Self-generated values are rejected.`}
      </CodeBlock>
      <CodeBlock title="Optional">
{`agentName   shown as "by …" on the card   (40 chars)
iconUrl     small icon URL                (200 chars)
logoUrl     public logo URL (sanitized)
tags        up to 8 tags, 20 chars each`}
      </CodeBlock>
      <P>
        Each entry in <span className="font-mono text-slate-300">inputs</span> is an object{" "}
        <span className="font-mono text-slate-300">{`{ key, label, placeholder, required? }`}</span>{" "}
        that tells the Hub which form fields to render for callers. Recommended{" "}
        <span className="font-mono text-slate-300">category</span> values:{" "}
        <span className="font-mono text-[11px] text-slate-400">intelligence, security, on-chain, builder, trading, content, agent-economy, base-ecosystem</span>{" "}
        (an unknown value defaults to <span className="font-mono text-slate-300">intelligence</span>).
      </P>

      <H2 id="nonce">3. Get a nonce (server-issued)</H2>
      <P>
        Before signing, ask the server for a nonce. It is minted, recorded, and spendable
        exactly once — so a captured request body cannot be replayed. A nonce you invent
        yourself is refused, because the server never recorded issuing it and therefore could
        never notice it coming back a second time.
      </P>
      <CodeBlock title="Endpoint" badge="GET">
{`GET https://blueagent.dev/api/auth/nonce
→ 200  { "nonce": "<64 lowercase hex chars>" }
  429  rate limited (10 / minute per IP)
  503  nonce could not be issued — retry shortly`}
      </CodeBlock>
      <P>
        The nonce is valid for <span className="font-mono text-slate-300">5 minutes</span> and
        is burned on first use, so fetch it immediately before signing and do not cache or
        reuse it. Every signed request needs its own: one to submit, and a fresh one for each
        remove. If a submit is rejected after the nonce is spent — a failed x402 probe, a
        price mismatch — fetch a new nonce and re-sign. (Both of those 422s already required a
        re-sign, since the endpoint and the price are inside the signed message.)
      </P>

      <H2 id="sign">4. Sign the registration (SIWE)</H2>
      <P>
        The signature proves you control <span className="font-mono text-slate-300">builderAddress</span>.
        Build the message string exactly as below and sign it with that wallet — the bytes
        must match character-for-character (including the column spacing), or verification
        fails. Reuse this builder verbatim:
      </P>
      <CodeBlock title="Canonical registration message" badge="byte-identical">
{`const message = [
  "Blue Hub Builder Registration",
  "",
  "Wallet:    " + builderAddress.toLowerCase(),
  "Tool ID:   " + id,
  "Tool name: " + name,
  "Endpoint:  " + endpoint,
  "Price:     " + priceUSDC + " USDC units (6 decimals)",
  "Nonce:     " + nonce,
  "",
  "By signing this message I confirm I control the wallet above and",
  "agree to the Blue Hub builder terms: 95/5 revenue split with the",
  "Blue Hub treasury, USDC settlement on Base.",
].join("\\n");`}
      </CodeBlock>

      <H2 id="example">5. Full example (agent, viem)</H2>
      <P>
        A Base agent submitting a $0.05 tool priced at 50000 atomic units. The endpoint
        must already charge exactly 50000 units, or the price-match gate rejects it.
      </P>
      <CodeBlock title="submit.ts" badge="TypeScript">
{`import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as \`0x\${string}\`);

const id         = "my-alpha-signal";
const name       = "My Alpha Signal";
const endpoint   = "https://my-agent.example/api/x402/alpha";
const priceUSDC  = 50000;               // atomic USDC units = $0.05
const builderAddress = account.address;

// Server-issued, single-use. Fetch it immediately before signing — it expires
// in 5 minutes and is burned the first time it is used.
const nonceRes = await fetch("https://blueagent.dev/api/auth/nonce", { cache: "no-store" });
if (!nonceRes.ok) throw new Error("Could not get a nonce: " + nonceRes.status);
const { nonce } = await nonceRes.json();

const message = [
  "Blue Hub Builder Registration",
  "",
  "Wallet:    " + builderAddress.toLowerCase(),
  "Tool ID:   " + id,
  "Tool name: " + name,
  "Endpoint:  " + endpoint,
  "Price:     " + priceUSDC + " USDC units (6 decimals)",
  "Nonce:     " + nonce,
  "",
  "By signing this message I confirm I control the wallet above and",
  "agree to the Blue Hub builder terms: 95/5 revenue split with the",
  "Blue Hub treasury, USDC settlement on Base.",
].join("\\n");

const signature = await account.signMessage({ message });

const res = await fetch("https://blueagent.dev/api/hub/tools", {
  method:  "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id, name, endpoint, priceUSDC, nonce, signature, builderAddress,
    description: "Live Base alpha signal, one call = one setup.",
    category:    "intelligence",
    price:       "$0.05",
    inputs: [
      { key: "token", label: "Token symbol or address", placeholder: "e.g. BLUE", required: true },
    ],
  }),
});

const out = await res.json();
console.log(res.status, out.ok ? out.tool.status : out.error);`}
      </CodeBlock>

      <H2 id="responses">6. Responses & errors</H2>
      <P>Success returns <span className="font-mono text-slate-300">201</span> with the saved tool and the probe result.</P>
      <CodeBlock title="Status codes">
{`201  { ok: true, tool, probe }        listed live
400  Missing field / Invalid id / Invalid builderAddress /
     Invalid endpoint URL / Endpoint must use https:// /
     priceUSDC must be 0..100000000 / inputs must be a 1..12 array /
     Signature verification failed
401  Malformed nonce  — not a server-issued value (a UUID or a
     timestamp lands here)
401  Nonce unknown or expired  — never issued by us, or older
     than 5 minutes
401  Nonce already used  — one nonce, one request
401  Invalid signature — does not match builderAddress
409  Tool id "<id>" already registered
422  x402 probe failed (probe.reason)  — endpoint not a live Base
     x402 endpoint, or missing payTo/asset/network
422  Price mismatch — priceUSDC != the endpoint's amount
429  Rate limit exceeded (5 / minute)
503  Could not verify the nonce  — registry storage unavailable,
     retry shortly. Never treated as a valid nonce.`}
      </CodeBlock>

      <Callout color="#f87171" title="Price must match, exactly">
        The x402 &quot;exact&quot; scheme verifies the signed authorization value against
        your endpoint&apos;s advertised <span className="font-mono">maxAmountRequired</span>{" "}
        byte-for-byte. If <span className="font-mono">priceUSDC</span> differs from what the
        endpoint charges, every paid call fails verification — so the registry rejects the
        mismatch up front with a 422. Set the listed price to exactly your endpoint amount.
      </Callout>

      <H2 id="after">7. After listing</H2>
      <P>
        The tool is live immediately and callable through the Hub proxy, which forwards
        payment to your endpoint and tracks usage. Your 95% share of each paid call accrues
        in the registry for batched payout. The green{" "}
        <span className="font-mono text-slate-300">✓ Verified</span> badge is a separate,
        manual trust review — auto-live tools start unverified.
      </P>
      <P>
        To remove a tool, fetch a <em>fresh</em> nonce from{" "}
        <span className="font-mono text-slate-300">GET /api/auth/nonce</span>, sign the
        canonical removal message from your builder wallet, and send{" "}
        <span className="font-mono text-slate-300">DELETE /api/hub/tools/&lt;id&gt;</span>{" "}
        with <span className="font-mono text-slate-300">{`{ owner, signature, nonce }`}</span>{" "}
        (the Creator Dashboard does this for you). The nonce you used to submit is already
        spent and will 401. Removes are single-use for a stronger reason than submits: the
        removal message carries no timestamp, so before this change a captured DELETE body
        stayed valid forever — and the moment you re-registered the same slug, that old body
        would take the listing down a second time.
      </P>

      <PrevNext current="/docs/list-a-tool" />
    </article>
  );
}
