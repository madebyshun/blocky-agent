import Link from "next/link";
import { DocHeader, H2, P, Card, CardGrid, Callout, PrevNext } from "../_ui";
import { TOOL_COUNT } from "@/lib/agent-tools";

export const metadata = {
  title: "Blue Hood — Blue Agent Docs",
  description:
    "Oracle-vs-DEX drift signals for tokenized stocks on Base (Coinbase B20) and Robinhood Chain: every call graded in public, arrow signals, review-and-sign trading.",
};

const PILLARS = [
  {
    name: "See",
    accent: "#4FC3F7",
    items: [
      { k: "Hood", d: "Live drift board — tokenized stocks on Base + RH, Chainlink oracle vs DEX pool spot, verdict every 5 min." },
      { k: "Radar", d: "Discovery — movers, flow, new-on-chain, whale watch. Coming in Stage 1." },
      { k: "Wallet", d: "Read-only position dashboard with per-token drift column. Coming in Stage 1." },
    ],
  },
  {
    name: "Act",
    accent: "#34D399",
    items: [
      { k: "Trade", d: "Standalone quote → prepare → sign panel. Non-custodial. Coming in Stage 2." },
      { k: "Bridge", d: "Route finder for Base/Arb/ETH → Robinhood Chain, deep-link to canonical bridge. Coming in Stage 2." },
    ],
  },
  {
    name: "Automate",
    accent: "#A78BFA",
    items: [
      { k: "Tasks", d: "Scheduled agent jobs from 4 templates. Runs via cron + ERC-4337 session keys. Coming in Stage 3." },
      { k: "Chat", d: "Ask the agent anything — every skill in the Hub is one prompt away." },
    ],
  },
  {
    name: "Build",
    accent: "#FBBF24",
    items: [
      { k: "Hub", d: `${TOOL_COUNT} x402 skills — call any tool for $0.05, no auth. B2B routing endpoints available for indexes.` },
      { k: "Docs / Embed", d: "Public API + embed widgets for other builders." },
    ],
  },
];

const ARROWS = [
  { name: "arb", d: "Market OPEN + |drift| ≥ 1% + LONG_DEX or SHORT_DEX verdict." },
  { name: "drift", d: "Market CLOSED + |drift| ≥ 2% during premarket/afterhours." },
  { name: "flow", d: "Unusual buy/sell pressure per token. From D2 flow analytics." },
];

const GATES = [
  { name: "Dust gate", d: "Skips tokens with total_tvl_usd < $5k across ALL pools (not just primary)." },
  { name: "Feed staleness gate", d: "Skips arb when Chainlink last update is older than 15 min during regular hours." },
  { name: "Dedup gate", d: "Skips if there's already an open arrow for (ticker, type)." },
  { name: "V3 executability", d: "Trade panel refuses Sign if the pool is Uniswap V4-only (router is V3, will revert)." },
];

const GRADING = [
  {
    name: "drift → HIT / MISS",
    d: "HIT if the DEX↔oracle price gap closes ≥ 50% within grading_window_h NYSE regular-session hours; otherwise MISS. The clock counts regular-session hours only — Chainlink freezes at the close, so afterhours time doesn't count.",
  },
  {
    name: "arb → HIT / MISS",
    d: "HIT if the DEX↔oracle spread narrows below 0.5% within 4 NYSE regular-session hours; otherwise MISS. Same regular-session clock as drift.",
  },
  {
    name: "flow → informational",
    d: "Never graded HIT/MISS. Flow arrows are context, not a scored prediction, so they never enter any hit-rate denominator.",
  },
  {
    name: "VOID",
    d: "Any drift/arb arrow graded before its regular-session window fully elapsed is VOID — excluded from hit-rate, but shown plainly as VOID in the receipts. Honest evidence, never hidden.",
  },
];

export default function BlueHoodDoc() {
  return (
    <article>
      <DocHeader
        eyebrow="Products"
        title="Blue Hood"
        lead="Oracle-vs-DEX drift signals for tokenized stocks on Base (Coinbase B20) and Robinhood Chain — the intelligence layer nobody else on chain is building. Drift monitoring, arrow signals with a public track record where every call is graded, and a review-and-sign trade panel that keeps every private key with the user."
      />

      <Callout>
        <strong>Positioning.</strong> Tokenized stocks trade 24/7 onchain
        across Base (Coinbase B20) and Robinhood Chain, but their Chainlink
        oracles only tick 24/5. Plenty of venues own execution; nobody owns
        that oracle-vs-DEX drift, cross-pool discrepancy detection, or a
        public signal track record that grades every call. Blue Hood is
        BlueAgent&apos;s wedge in that gap.
      </Callout>

      <H2>Four semantic layers</H2>
      <P>
        Blue Hood is built as four discrete layers. Each one has its own
        cron / route / doc anchor so you can trace any card back to the
        skill that produced it.
      </P>
      <CardGrid cols={4}>
        <Card title="T-A · See">
          Poller measures drift between Chainlink oracle and DEX pool.
          Runs every 5 min via <code>/api/cron/blue-hood/poll</code>.
          Writes <code>bh:snapshot:latest</code> to KV.
        </Card>
        <Card title="T-B · Explain">
          A4 rh-stock-agent-brief LLM chain (Virtuals → Venice)
          writes a 1-line context for each fired arrow. Runs every 1 min
          via <code>/api/cron/blue-hood/brief-worker</code>.
        </Card>
        <Card title="T-C/D · Alert">
          Drift board (<Link href="/hood" className="underline">/hood</Link>),
          inbox (<Link href="/hood/inbox" className="underline">/hood/inbox</Link>),
          + Web Push fan-out. Every arrow gets a serial <code>#0001…</code>.
        </Card>
        <Card title="T-E · Act">
          ReviewSignPanel — non-custodial, wagmi <code>useSendTransaction</code>,
          recipient = <code>useAccount().address</code> verbatim. Two
          signs: approve → swap.
        </Card>
      </CardGrid>

      <H2>Arrow types</H2>
      <P>Rule engine (<code>src/lib/blue-hood/rule-engine.ts</code>) fires an arrow when a snapshot row matches one of:</P>
      <CardGrid cols={3}>
        {ARROWS.map((a) => (
          <Card key={a.name} title={a.name}>{a.d}</Card>
        ))}
      </CardGrid>

      <H2>Safety gates</H2>
      <P>Every arrow candidate passes through in order. Any gate rejection = no arrow fired.</P>
      <CardGrid cols={2}>
        {GATES.map((g) => (
          <Card key={g.name} title={g.name}>{g.d}</Card>
        ))}
      </CardGrid>

      <H2 id="grading">Grading rules</H2>
      <P>
        Every fired arrow is later graded against real price data — this is
        what makes the track record a <em>record</em> and not a feed of
        opinions. The rules below are the exact ones in{" "}
        <code>src/lib/blue-hood/grader.ts</code>; the machine-readable version
        ships in the <code>meta.grading</code> block of the{" "}
        <code>/api/acp/track-record</code> response so an agent can re-derive
        any number we publish.
      </P>
      <CardGrid cols={2}>
        {GRADING.map((g) => (
          <Card key={g.name} title={g.name}>{g.d}</Card>
        ))}
      </CardGrid>
      <Callout title="Receipts are public, the headline is earned">
        Every graded arrow and its outcome (HIT / MISS / VOID) is returned
        freely — that&apos;s the evidence, and anyone may compute a hit-rate
        from it. But the <em>headline</em> number that bears our name (the
        aggregate %, per-type %, and record curve) stays hidden until the
        sample earns it: <strong>30 graded</strong> arrows in the trailing 7
        days for the aggregate, <strong>15</strong> of a type for that
        type&apos;s own number. Below the bar the API returns{" "}
        <code>{"{ ready: false, graded: N, needed: M }"}</code> and no
        percentage. The record curve is a cumulative HIT−MISS walk
        (<code>basis: &quot;cumulative_hit_minus_miss&quot;</code>), not dollars —
        grading measures signal accuracy, not PnL.
      </Callout>

      <H2>Product roadmap (4 groups, 9 nav items)</H2>
      <P>Blue Hood is the first pillar of the &quot;onchain Agent OS&quot; relaunch. All new features are surfaces on top of skills that already exist in <Link href="/hub" className="underline">/hub</Link> — no new engines.</P>
      {PILLARS.map((p) => (
        <div key={p.name} className="mt-8">
          <div className="font-mono text-[11px] tracking-widest uppercase mb-3" style={{ color: p.accent }}>
            {p.name}
          </div>
          <CardGrid cols={p.items.length === 2 ? 2 : 3}>
            {p.items.map((it) => (
              <Card key={it.k} title={it.k}>{it.d}</Card>
            ))}
          </CardGrid>
        </div>
      ))}

      <H2>Non-custodial guarantees</H2>
      <P>The T-E panel enforces five hard rules — search the codebase for any of them and the grep audit MUST catch every site:</P>
      <ul className="mt-4 space-y-2 text-slate-400 text-[15px] leading-relaxed">
        <li>1. No private-key storage, no session key delegated to the server, no gasless-relayer signing on user&apos;s behalf.</li>
        <li>2. Recipient = <code className="text-white">useAccount().address</code> VERBATIM. No default, no env fallback, no server-supplied recipient.</li>
        <li>3. No auto-execute. Every transaction is a deliberate user click.</li>
        <li>4. Warnings from tools display VERBATIM. The panel never edits warning text.</li>
        <li>5. When in doubt, disable Sign. Blocking a legitimate trade is cheaper than letting a bad one through.</li>
      </ul>

      <PrevNext current="/docs/blue-hood" />
    </article>
  );
}
