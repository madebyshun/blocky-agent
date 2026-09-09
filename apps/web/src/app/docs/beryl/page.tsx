import type { Metadata } from "next";
import { DocHeader, H2, H3, P, CodeBlock, Callout, Card, CardGrid, PrevNext } from "../_ui";

export const metadata: Metadata = {
  title: "Beryl / B20 — Blue Agent Docs",
  description:
    "Beryl is the Base network upgrade that introduces B20 — a Rust precompile for compliant tokenized assets. Learn the policy system, roles, and key addresses.",
};

export default function BerylDoc() {
  return (
    <article>
      <DocHeader
        eyebrow="Base Protocol"
        title="Beryl / B20"
        lead="B20 is Base's native standard for compliant tokenized assets — enforced by a Rust precompile in the node, not EVM bytecode. Enabled by the Beryl upgrade, and gated on-chain by the ActivationRegistry rather than by a calendar date."
      />

      <H2 id="what-is-b20">What is B20?</H2>
      <P>
        <strong>B20</strong> (Base Standard 20) is a tokenization primitive built directly into the Base node
        as a <strong>Rust precompile</strong>. This means compliance rules — pause, policy gating, supply
        caps — are enforced at the node level and cannot be bypassed by EVM bytecode.
      </P>
      <P>
        B20 is not a smart contract standard like ERC-20. It is an extension of the Base execution
        environment itself, activated by the <strong>Beryl</strong> network upgrade.
      </P>

      {/* No date here, on purpose. This callout used to read "Mainnet: scheduled
          July 8, 2026" — future tense, on a public page, about a day that had
          been and gone 61 days earlier. Worse, it was a THIRD date: the code
          gate uses June 25 (BERYL_TS in lib/b20/registry-logs.ts) and the chat
          system prompt said June 25 too, so the docs disagreed with the product
          in both directions at once.

          And it was measurably false at the time it was rewritten. The
          ActivationRegistry (0x8453…0001) answers isActivated() on-chain;
          reading it on 2026-09-06 returned asset:true, stablecoin:true for
          mainnet AND sepolia. So this box told a reader "not live yet" and then
          linked them to the B20 Hub, which correctly showed it live — one click
          apart.

          A promise with a date in it rots SILENTLY: the string never changes,
          only the calendar does, so no type-check and no test can fail on it.
          Name the authority instead of the day, and the sentence stays true
          whenever it is read. */}
      <Callout color="#4FC3F7" title="Beryl Activation">
        Activation is gated on-chain by the <strong>ActivationRegistry</strong>{" "}
        (<code className="text-slate-300">0x8453…0001</code>), which can flip up to ~1h after the
        Beryl hardfork lands on a network — so the registry, not a scheduled date, is the
        authority.
        {" "}Use the <a href="/app/b20" className="underline">B20 Hub</a> to see the live status,
        inspect tokens, check roles, and browse the on-chain registry.
      </Callout>

      <H2 id="variants">Two Variants</H2>
      <CardGrid cols={2}>
        <Card title="ASSET" color="#4FC3F7">
          For tokenized real-world assets — stocks, commodities, real estate. Supports rebase via a{" "}
          <code className="text-slate-300">multiplier()</code> view function.
        </Card>
        <Card title="STABLECOIN" color="#22C55E">
          For fiat-backed stable assets. Has a{" "}
          <code className="text-slate-300">currency()</code> field (e.g. <code className="text-slate-300">"USD"</code>)
          to declare the peg.
        </Card>
      </CardGrid>

      <H2 id="addresses">Key Addresses</H2>
      <P>All precompile addresses are the same on both mainnet and Sepolia.</P>
      <CodeBlock title="Base precompile addresses">
{`B20Factory        0xB20f000000000000000000000000000000000000
PolicyRegistry    0x8453000000000000000000000000000000000002
ActivationRegistry 0x8453000000000000000000000000000000000001`}
      </CodeBlock>

      <H2 id="deploying">Deploying a B20 Token</H2>
      <P>
        Tokens are created through the B20Factory. The factory takes a variant enum, a{" "}
        <code className="text-slate-300">salt</code>, abi-encoded{" "}
        <code className="text-slate-300">params</code>, and an array of{" "}
        <code className="text-slate-300">initCalls</code> that run atomically at deploy (e.g.{" "}
        <code className="text-slate-300">grantRole</code>, <code className="text-slate-300">updateSupplyCap</code>,
        seed <code className="text-slate-300">mint</code>).
      </P>
      <CodeBlock title="B20Factory.createB20 signature" badge="Solidity">
{`IB20Factory factory = IB20Factory(0xB20f000000000000000000000000000000000000);

// variant: 0 = ASSET (params encode decimals), 1 = STABLECOIN (params encode currency)
address token = factory.createB20(
  uint8   variant,     // 0 = ASSET, 1 = STABLECOIN
  bytes32 salt,        // deterministic deploy salt
  bytes   params,      // abi-encoded (version, name, symbol, initialAdmin, decimals|currency)
  bytes[] initCalls    // atomic setup: grantRole, updateSupplyCap, mint...
);`}
      </CodeBlock>
      <P>
        Encoding <code className="text-slate-300">params</code> and{" "}
        <code className="text-slate-300">initCalls</code> by hand is error-prone. The{" "}
        <code className="text-slate-300">b20_encode_deploy</code> MCP tool
        (see <a href="#mcp" className="text-[#4FC3F7] underline">Deploy from Claude / Cursor</a> below)
        builds the full calldata for you and returns a ready-to-sign{" "}
        <code className="text-slate-300">{`{ to, data, value }`}</code>.
      </P>

      <H2 id="policies">Policy System</H2>
      <P>
        B20 supports <strong>exactly two</strong> policy types: <code className="text-slate-300">ALLOWLIST</code>{" "}
        and <code className="text-slate-300">BLOCKLIST</code>. Policies are managed through the
        PolicyRegistry precompile and assigned to one of four scopes per token.
      </P>

      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden divide-y divide-[#1A1A2E] my-5">
        {[
          { scope: "TRANSFER_SENDER_POLICY",   desc: "Governs who can send tokens."          },
          { scope: "TRANSFER_RECEIVER_POLICY", desc: "Governs who can receive tokens."        },
          { scope: "TRANSFER_EXECUTOR_POLICY", desc: "Governs who can call transferFrom()."   },
          { scope: "MINT_RECEIVER_POLICY",     desc: "Governs who can receive newly minted tokens." },
        ].map(({ scope, desc }) => (
          <div key={scope} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 px-5 py-3">
            <code className="font-mono text-[11px] text-[#4FC3F7] shrink-0 sm:w-64">{scope}</code>
            <span className="font-mono text-[11px] text-slate-500">{desc}</span>
          </div>
        ))}
      </div>

      <P>policyId = 0 means <em>ALWAYS_ALLOW</em> (no restriction). To restrict a scope:</P>
      <CodeBlock title="Create + apply a policy" badge="Solidity">
{`IPolicyRegistry pReg = IPolicyRegistry(0x8453000000000000000000000000000000000002);

// 1. Create the policy (returns a uint64 policyId)
uint64 id = pReg.createPolicy(adminAddress, IPolicyRegistry.PolicyType.ALLOWLIST);

// 2. Add authorized addresses
pReg.addToPolicy(id, allowedAddress);

// 3. Apply it to the token scope
token.updatePolicy(token.TRANSFER_RECEIVER_POLICY(), id);`}
      </CodeBlock>

      <Callout color="#F59E0B" title="Common mistakes">
        There is <strong>no registerPolicy()</strong> function. Call{" "}
        <code className="text-slate-300">createPolicy(admin, PolicyType)</code> on the PolicyRegistry to
        get a policyId, then apply it with <code className="text-slate-300">token.updatePolicy(scope, policyId)</code>.
        Freeze-seize (<code className="text-slate-300">burnBlocked()</code>) and supply caps
        (<code className="text-slate-300">updateSupplyCap()</code>) are role-gated, not policy types.
      </Callout>

      <H2 id="roles">7 Core Roles</H2>
      <P>
        B20 uses OpenZeppelin AccessControl internally but omits{" "}
        <code className="text-slate-300">AccessControlEnumerable</code> — role holders cannot be
        enumerated. Use <code className="text-slate-300">hasRole(role, address)</code> to check specific
        accounts (see the <a href="/app/b20" className="text-[#4FC3F7] underline">B20 Hub → Roles tab</a>).
      </P>

      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden divide-y divide-[#1A1A2E] my-5">
        {[
          { role: "DEFAULT_ADMIN_ROLE", desc: "Manages all other roles. Sets supply cap via updateSupplyCap()." },
          { role: "MINT_ROLE",          desc: "Can mint new tokens to any address."  },
          { role: "BURN_ROLE",          desc: "Can burn tokens (holder must approve or consent)." },
          { role: "BURN_BLOCKED_ROLE",  desc: "Freeze-seize: can call burnBlocked(from, amount) to confiscate and burn tokens." },
          { role: "PAUSE_ROLE",         desc: "Can pause TRANSFER, MINT, or BURN features independently." },
          { role: "UNPAUSE_ROLE",       desc: "Can unpause any paused feature." },
          { role: "METADATA_ROLE",      desc: "Can update token name, symbol, and other metadata." },
        ].map(({ role, desc }) => (
          <div key={role} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 px-5 py-3">
            <code className="font-mono text-[11px] text-[#4FC3F7] shrink-0 sm:w-56">{role}</code>
            <span className="font-mono text-[11px] text-slate-500">{desc}</span>
          </div>
        ))}
      </div>

      <H2 id="supply-cap">Supply Cap</H2>
      <P>
        B20 tokens have an on-chain supply cap enforced at the node level. The sentinel value{" "}
        <code className="text-slate-300">type(uint128).max</code> means uncapped.
        Call <code className="text-slate-300">token.supplyCap()</code> to read the current cap.
        Update it with <code className="text-slate-300">token.updateSupplyCap(newCap)</code> —
        requires <code className="text-slate-300">DEFAULT_ADMIN_ROLE</code>.
      </P>

      <H2 id="pause">Pause / Unpause</H2>
      <P>
        Transfers, minting, and burns can each be paused independently.
        Call <code className="text-slate-300">token.isPaused(PausableFeature.TRANSFER)</code> to check.
        The Scanner tab in the B20 Hub shows live pause status for any token.
      </P>

      <H2 id="freeze-seize">Freeze-Seize (burnBlocked)</H2>
      <P>
        The BURN_BLOCKED_ROLE grants the ability to forcibly confiscate and burn tokens from any address.
        This is distinct from policy blocking (which prevents transfers) — burnBlocked permanently removes
        tokens from circulation. It requires explicit regulatory authority and is designed for asset
        recovery in regulated markets.
      </P>
      <CodeBlock title="Freeze-seize" badge="Solidity">
{`// Requires BURN_BLOCKED_ROLE
token.burnBlocked(holderAddress, amount);`}
      </CodeBlock>

      <H2 id="inspector">On-Chain Inspector</H2>
      <P>
        Use the <a href="/app/b20" className="text-[#4FC3F7] underline">B20 Hub</a> to inspect any token
        live — zero LLM, all data from multicall. Check scanner results, role holders, the on-chain
        registry, and simulate transfers before they happen.
      </P>

      <Callout color="#22C55E" title="Deploy B20 via Blue Chat">
        In Blue Chat, type{" "}
        <code className="text-slate-300">deploy a B20 asset token named "My Token" symbol "MTK"</code> —
        the agent will generate and sign a createB20 Factory transaction directly.
      </Callout>

      <H2 id="mcp">Deploy from Claude / Cursor (MCP)</H2>
      <P>
        Blue Agent exposes B20 as MCP tools, so you can deploy, mint, grant roles, and take payments
        straight from Claude Code, Claude Desktop, or Cursor. Point your client at the remote server —
        nothing to install:
      </P>
      <CodeBlock title="Claude Code / Cursor / Desktop config" badge="MCP">
{`{
  "mcpServers": {
    "blue-agent": {
      "url": "https://blueagent.dev/api/mcp"
    }
  }
}`}
      </CodeBlock>
      <P>
        The B20 tools are <strong>non-custodial</strong> — they never touch your keys and never charge a
        payment. The encoders return a{" "}
        <code className="text-slate-300">{`{ to, data, value }`}</code> that you sign in your own wallet
        (via EIP-5792 <code className="text-slate-300">send_calls</code> or the Base MCP);{" "}
        <code className="text-slate-300">b20_check_activation</code> and{" "}
        <code className="text-slate-300">b20_read_token</code> are read-only on-chain queries. Blue Agent
        goes factory-direct — no platform fee is added.
      </P>

      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden divide-y divide-[#1A1A2E] my-5">
        {[
          { tool: "b20_check_activation",       desc: "Read live whether ASSET / STABLECOIN are active on mainnet or Sepolia (ActivationRegistry)." },
          { tool: "b20_read_token",             desc: "Inspect a token live via multicall — isB20, supply, cap, variant, pause + policy gating (zero LLM)." },
          { tool: "b20_encode_deploy",          desc: "Encode createB20 — name, symbol, variant, admin, optional decimals / supply cap / seed mint." },
          { tool: "b20_encode_mint",            desc: "Encode mint (or mintWithMemo) on an existing token. Signer must hold MINT_ROLE." },
          { tool: "b20_encode_burn",            desc: "Encode burnWithMemo — burn from the caller's balance with a memo. Signer must hold BURN_ROLE." },
          { tool: "b20_encode_grant_mint_role", desc: "Encode grantRole(MINT_ROLE, account). Signer must hold DEFAULT_ADMIN_ROLE." },
          { tool: "b20_encode_payment",         desc: "Encode transferWithMemo — pay with an on-chain memo / order id for reconciliation." },
        ].map(({ tool, desc }) => (
          <div key={tool} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 px-5 py-3">
            <code className="font-mono text-[11px] text-[#22C55E] shrink-0 sm:w-64">{tool}</code>
            <span className="font-mono text-[11px] text-slate-500">{desc}</span>
          </div>
        ))}
      </div>

      <P>A typical non-custodial deploy flow from your MCP client:</P>
      <ol className="space-y-2.5 my-5">
        {[
          "Ask b20_check_activation for your target chain — createB20 reverts until B20 is active there.",
          "Ask b20_encode_deploy with name, symbol, variant, and your admin wallet address.",
          "Sign the returned { to, data, value } in your wallet (EIP-5792 send_calls / Base MCP).",
          "After deploy, use b20_encode_mint / b20_encode_payment for ongoing operations.",
        ].map((step, i) => (
          <li key={i} className="flex gap-3 font-mono text-[12px] text-slate-400 leading-relaxed">
            <span className="text-[#22C55E] shrink-0">{i + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>

      <Callout color="#4FC3F7" title="More MCP tools">
        See the <a href="/docs/mcp" className="underline">MCP Setup</a> page for the full tool catalog —
        console commands, Hub tools, and the B20 builders — plus client-specific setup notes.
      </Callout>

      <H2 id="methodology">How the B20 scanner works</H2>
      <P>
        Every result in the <a href="/app/b20" className="text-[#4FC3F7] underline">B20 Hub</a> Scanner is
        read live from Base RPC via multicall — zero LLM, zero guessing. The numbers and flags come straight
        from on-chain state, never from a model.
      </P>

      <H3 id="inspection-flow">Inspection flow</H3>
      <P>The scanner reads each token in a fixed, deterministic sequence:</P>
      <ol className="space-y-2.5 my-5">
        {[
          "Validate the address format.",
          "Check isB20 against the B20Factory precompile — confirm it is a real B20, not arbitrary EVM bytecode.",
          "Read core state: name, symbol, decimals, total supply, supply cap, and variant.",
          "Read pause status per feature: transfer, mint, and burn.",
          "Read the policy ID per scope: transfer sender, transfer receiver, transfer executor, and mint receiver.",
          "Read variant detail: the rebase multiplier (Asset) or the currency code (Stablecoin).",
        ].map((step, i) => (
          <li key={i} className="flex gap-3 font-mono text-[12px] text-slate-400 leading-relaxed">
            <span className="text-[#4FC3F7] shrink-0">{i + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>

      <H3 id="trust-verdict">Trust verdict — deterministic, not a score</H3>
      <P>
        We surface concrete flags, never a single pass/fail number that would overstate certainty. The
        verdict is computed in code from the reads above, so the same on-chain state always yields the same
        flags.
      </P>
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] divide-y divide-[#1A1A2E] my-5">
        {[
          { kind: "warn", text: "Transfers, mint, or burn are paused — the issuer can freeze that operation." },
          { kind: "warn", text: "A transfer or mint scope is policy-gated by an allowlist or blocklist, not open." },
          { kind: "warn", text: "Supply is uncapped — the issuer can mint without limit." },
          { kind: "ok",   text: "No pauses, no restrictive policies, and a capped supply — no issuer-side transfer restrictions detected at read time." },
        ].map(({ kind, text }, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3">
            <span className="font-mono text-sm shrink-0" style={{ color: kind === "warn" ? "#F59E0B" : "#22C55E" }}>
              {kind === "warn" ? "!" : "✓"}
            </span>
            <span className="font-mono text-[12px] leading-relaxed" style={{ color: kind === "warn" ? "#FCD34D" : "#86efac" }}>
              {text}
            </span>
          </div>
        ))}
      </div>

      <H3 id="limitations">Limitations</H3>
      <ul className="space-y-2.5 my-5">
        {[
          "B20 omits AccessControlEnumerable, so role holders cannot be listed — each role is only checked per wallet via hasRole.",
          "Reads reflect on-chain state at the moment of the scan. Roles and policies can change afterward.",
          "Advisory only — verify independently before trusting or trading a token.",
        ].map((text, i) => (
          <li key={i} className="flex gap-3 font-mono text-[12px] text-slate-400 leading-relaxed">
            <span className="text-slate-600 shrink-0">—</span>
            <span>{text}</span>
          </li>
        ))}
      </ul>

      <PrevNext current="/docs/beryl" />
    </article>
  );
}
