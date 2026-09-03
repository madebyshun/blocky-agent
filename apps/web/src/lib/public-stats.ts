/**
 * Public traction stats — the ONLY user-facing aggregate surface.
 *
 * Hard privacy rule: this module returns AGGREGATE, on-chain-verifiable numbers
 * only. It must NEVER expose per-user data — no wallet addresses, no ledger
 * balances/spend, no launcher handles/identities. `uniqueCreators` is a COUNT
 * derived from launch records; the underlying identity values are never emitted.
 *
 * Every field is fault-tolerant: a data-source failure degrades to a safe zero /
 * null (rendered as "—"), never a thrown error and never a fabricated number.
 *
 * Sources:
 *   - Launches:  KV `bluechat:launches` (real on-chain deploys via Bankr).
 *   - Usage:     KV `usage:<toolId>` counters — lifetime paid tool runs (aggregate
 *                sum; no wallet is ever part of the key).
 *   - Users:     KV `claim:count` — # wallets that claimed the free-credit airdrop
 *                (a count only; capped at 300). The closest honest "onboarded" number.
 *   - Activity:  Derived live from every `ledger:<addr>` row via getLedgerActivity()
 *                — distinct wallets that spent, Σ credits debited, and chat-message
 *                spend events. COUNTS/SUMS only; no address is ever emitted.
 *   - Product:   AGENT_TOOLS catalog length + the 5 core commands (static).
 *
 * NOTE (no fabrication): the active-users / credits-spent / chat-messages numbers
 * are computed by scanning the existing per-wallet ledgers and summing their
 * recorded spend history — real all-time activity, not a fabricated or forward-only
 * counter. Per-row history is capped at 50 events, so the credit/message sums are
 * exact at current scale and a conservative floor thereafter. Every value degrades
 * to 0 on a source failure; none is ever invented.
 *
 * REMOVED: a `staking` block that read BlueMarketStaking.totalStaked() on Base and
 * published it as a headline metric. The contract is untouched and still live, but
 * the app no longer sells a stake, so quoting its TVL as traction advertised a
 * retired product. The field is gone from the response, not zeroed — an absent
 * number is honest, a zero would be a false measurement.
 */

import { getLaunches } from "./launches";
import { AGENT_TOOLS } from "./agent-tools";
import { kvGet } from "./kv";
import { getLedgerActivity } from "./credit-ledger";
import { getX402Settlements } from "./x402-settlements";

export interface PublicLaunchLite {
  name:       string;
  symbol:     string;
  address:    string;
  txHash:     string | null;
  launchedAt: number;
}

export interface PublicStats {
  updatedAt: number;
  launches: {
    total:          number;
    uniqueCreators: number;
    peakPerDay:     number;
    byDay:          { date: string; count: number }[]; // chronological, launch days only
    recent:         PublicLaunchLite[];                 // newest first, creator stripped
  };
  product: {
    tools:    number;
    commands: number;
  };
  usage: {
    totalRuns:  number;                          // Σ usage:<id> across the catalog
    revenueEst: string;                          // "$X.XX" — Σ(runs × price)
    topTools:   { name: string; runs: number }[]; // top 5 by runs (names only, aggregate)
  };
  users: {
    claims:   number;  // wallets that claimed the free-credit airdrop (count only)
    claimCap: number;  // airdrop cap (300)
    total:    number;  // distinct wallets that ever spent credits (count only)
  };
  credits: {
    spent:    number;  // Σ credits debited across all wallets (chat + tool)
    messages: number;  // chat messages debited (reason "chat:*")
  };
  settlement: {        // real USDC settled on Base via the Coinbase CDP facilitator
    usdc:   number;    // human USDC settled (0 on source failure)
    count:  number;    // # of confirmed on-chain settlements
    lastTx: string | null; // latest settlement tx hash (Basescan proof) — null if none
    ok:     boolean;   // false ⟹ meter unavailable → render "—", never a fake number
  };
}

const CORE_COMMANDS = 5; // idea · build · audit · ship · raise
const CLAIM_CAP     = 300; // mirrors credits/claim route
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10); // UTC YYYY-MM-DD

/** Parse a "$0.05" price string to a number; non-numeric ⟹ 0. */
function priceNum(price?: string): number {
  if (!price) return 0;
  const n = parseFloat(price.replace("$", "").trim());
  return Number.isNaN(n) ? 0 : n;
}

export async function buildPublicStats(): Promise<PublicStats> {
  // ── Launches (KV) ──
  let total = 0, uniqueCreators = 0, peakPerDay = 0;
  let byDay: { date: string; count: number }[] = [];
  let recent: PublicLaunchLite[] = [];
  try {
    const launches = await getLaunches();
    total = launches.length;

    // Unique creators: COUNT only — identity values are never surfaced.
    const creators = new Set<string>();
    const perDay = new Map<string, number>();
    for (const l of launches) {
      const id = (l.feeRecipient?.value ?? "").toLowerCase();
      if (id) creators.add(id);
      if (l.launchedAt) {
        const k = dayKey(l.launchedAt);
        perDay.set(k, (perDay.get(k) ?? 0) + 1);
      }
    }
    uniqueCreators = creators.size;
    byDay = [...perDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, count]) => ({ date, count }));
    peakPerDay = byDay.reduce((m, d) => Math.max(m, d.count), 0);

    // Recent feed — strip creator identity + private metadata.
    recent = launches
      .slice()
      .sort((a, b) => (b.launchedAt ?? 0) - (a.launchedAt ?? 0))
      .slice(0, 15)
      .map((l) => ({
        name:       l.tokenName ?? "",
        symbol:     l.tokenSymbol ?? "",
        address:    l.tokenAddress ?? "",
        txHash:     l.txHash ?? null,
        launchedAt: l.launchedAt ?? 0,
      }));
  } catch {
    /* degrade to zeros */
  }

  // ── Product breadth (static) ──
  const tools = Array.isArray(AGENT_TOOLS) ? AGENT_TOOLS.length : 0;

  // ── Usage (KV usage:<id> counters — aggregate, no wallet in key) ──
  let totalRuns = 0, revenueEstNum = 0;
  let topTools: { name: string; runs: number }[] = [];
  try {
    const rows = await Promise.all(
      AGENT_TOOLS.map(async (tl) => {
        const runs = (await kvGet<number>(`usage:${tl.id}`)) ?? 0;
        return { name: tl.name, runs, rev: runs * priceNum(tl.price) };
      }),
    );
    for (const r of rows) { totalRuns += r.runs; revenueEstNum += r.rev; }
    topTools = rows
      .filter((r) => r.runs > 0)
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 5)
      .map((r) => ({ name: r.name, runs: r.runs }));
  } catch {
    /* degrade to zeros */
  }

  // ── Users onboarded (airdrop claim count — a count, never an address) ──
  let claims = 0;
  try { claims = (await kvGet<number>("claim:count")) ?? 0; } catch { /* leave 0 */ }

  // ── Active users + credits spent + chat messages ──
  // Derived live from the existing per-wallet ledgers (aggregate counts/sums only,
  // no address emitted) — real all-time activity, not a forward-only counter.
  let totalUsers = 0, creditsSpent = 0, chatMessages = 0;
  try {
    const act = await getLedgerActivity();
    totalUsers = act.activeUsers; creditsSpent = act.creditsSpent; chatMessages = act.chatMessages;
  } catch { /* degrade to zeros */ }

  // ── Onchain settlement (Coinbase CDP facilitator) ──
  // Aggregate USDC actually settled on Base via CDP /settle. Forward-only meter,
  // count/sum/lastTx only — no wallet is ever stored. Null source ⟹ ok:false → "—".
  let settlement = { usdc: 0, count: 0, lastTx: null as string | null, ok: false };
  try {
    const s = await getX402Settlements();
    if (s) settlement = { usdc: s.usdc, count: s.count, lastTx: s.lastTx, ok: true };
  } catch { /* leave ok:false → renders "—" */ }

  return {
    updatedAt: Date.now(),
    launches: { total, uniqueCreators, peakPerDay, byDay, recent },
    product: { tools, commands: CORE_COMMANDS },
    usage: { totalRuns, revenueEst: `$${revenueEstNum.toFixed(2)}`, topTools },
    users: { claims, claimCap: CLAIM_CAP, total: totalUsers },
    credits: { spent: creditsSpent, messages: chatMessages },
    settlement,
  };
}
