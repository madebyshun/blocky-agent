/**
 * Blue Feed — shared cron logic (used by the hourly + daily routes).
 *
 * Snapshot-once architecture:
 *  - each run = one cycle (cycleId = timestamp rounded to the hour)
 *  - a shared context { tvl, sentiment, pulse } is derived once per cycle and
 *    attached to every item in that cycle, so cards stay numerically consistent
 *  - items are stored in the "feed:items" array, deduped per (cycleId, tool)
 *  - the cycle context is also stored at feed:cycle:{cycleId}:context
 *
 * Tools run via the internal x402 bypass (X-Blue-Internal + X-Blue-Service).
 */
import { kvSet, kvMutate }           from "@/lib/kv";
import { internalX402Headers, hasInternalKey } from "@/lib/x402-internal";
// PendingPick is written here and read by picks-check.ts handler (same schema).
type PendingPick = {
  symbol:          string;
  price_at_signal: number | null;
  signal_ts:       number;
  check_after:     number;
  volume_24h:      number | null;
  liquidity_usd:   number | null;
};

const CRON_SECRET          = process.env.CRON_SECRET ?? "";
const BASE_URL             = "https://blueagent.dev/api/x402";
const HOUR_MS              = 3_600_000;

/**
 * Blue Feed is HIDDEN + PAUSED while it's rebuilt. The hourly/daily cron routes
 * short-circuit on this flag so they do NO LLM/x402 work and write no items
 * (the feed UI is parked at 404 anyway). Flip to `false` to resume the feed.
 */
export const FEED_PAUSED = true;

export type FeedAgent = "blueagent";

export interface FeedItem {
  id: string;
  tool: string;
  timestamp: number;
  cycleId: number;
  title: string;
  summary: string;
  /** Hint for feed card rendering: signal (buy/watch), info, watch, track */
  itemType?: "signal" | "info" | "watch" | "track";
  data: Record<string, unknown>;
  shareText: string;
  agent: FeedAgent;
}

export interface CycleContext { tvl: string | null; sentiment: string | null; pulse: string | null }

export type Job = { tool: string; agent: FeedAgent; body: Record<string, unknown>; title?: string };

// ── helpers ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v.replace(/[$,]/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}
function fmtUsd(v: unknown): string | null {
  const n = num(v); if (n === null) return null;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
function fmtPct(v: unknown): string | null {
  const n = num(v); if (n === null) return null;
  return `${n >= 0 ? "↑ +" : "↓ "}${n.toFixed(1)}%`;
}
type Metric = { label: string; value: string };
function metric(label: string, value: string | null | undefined): Metric | null { return value ? { label, value } : null; }
function clean(ms: (Metric | null)[]): Metric[] { return ms.filter((m): m is Metric => !!m).slice(0, 3); }
const titleCase = (s: string) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Transform a tool response into a FeedItem. Defensive: never throws. */
function toFeedItem(job: Job, resp: Any, cycleId: number, idx: number): FeedItem {
  const ts = Date.now();
  let title = job.title ?? titleCase(job.tool);
  let summary = "";
  let metrics: Metric[] = [];

  try {
    switch (job.tool) {
      case "token-alpha": {
        const sym = resp.symbol ?? resp.token ?? "Token";
        const sig = resp.signal ?? "—";
        title = `${sym} · ${sig}`;
        summary = resp.thesis ?? resp.narrative_fit ?? "Trade signal updated.";
        metrics = clean([metric("Signal", typeof sig === "string" ? sig : null), metric("Confidence", resp.confidence != null ? `${resp.confidence}` : null), metric("Entry", fmtUsd(resp.entry_price))]);
        break;
      }
      case "base-alpha": {
        title = "Base Alpha";
        const top = Array.isArray(resp.momentum_picks) ? resp.momentum_picks[0] : null;
        summary = top?.symbol ? `Top momentum: ${top.symbol}${top.signal_type ? ` (${top.signal_type})` : ""}. Market ${resp.market_phase ?? "—"}.` : `Base market phase: ${resp.market_phase ?? "—"}.`;
        metrics = clean([metric("Base TVL", fmtUsd(resp.base_tvl_usd)), metric("TVL 7d", fmtPct(resp.tvl_change_7d)), metric("Top pick", top?.symbol ?? null)]);
        break;
      }
      case "narrative-pulse": {
        title = "Narrative Pulse";
        const arr = Array.isArray(resp.trending_narratives) ? resp.trending_narratives : [];
        const names = arr.map((n: Any) => n?.name).filter(Boolean).slice(0, 3);
        summary = names.length ? `Trending: ${names.join(" · ")}` : "Live Base narrative phases updated.";
        metrics = clean([metric("Narratives", arr.length ? `${arr.length}` : null), metric("Top", arr[0]?.name ?? null), metric("Phase", arr[0]?.phase ?? null)]);
        break;
      }
      case "base-pulse": {
        title = "Base Pulse";
        const score = resp.pulse_score ?? resp.score;
        const sentiment = resp.sentiment ?? resp.market_sentiment;
        summary = `Base ecosystem snapshot${sentiment ? ` — sentiment ${sentiment}` : ""}.`;
        metrics = clean([metric("TVL", fmtUsd(resp.tvl_usd ?? resp.base_tvl_usd ?? resp.tvl)), metric("Sentiment", typeof sentiment === "string" ? sentiment : null), metric("Pulse", score != null ? `${score}` : null)]);
        break;
      }
      case "whale-tracker": {
        title = "Whale Tracker";
        const act = resp.whaleActivity ?? resp.signal ?? "NEUTRAL";
        summary = resp.recommendation ?? resp.trend ?? "Smart-money flow on Base updated.";
        metrics = clean([metric("Activity", typeof act === "string" ? act : null), metric("Signal", typeof resp.signal === "string" ? resp.signal : null), metric("Strength", resp.signalStrength != null ? `${resp.signalStrength}` : null)]);
        break;
      }
      case "ecosystem-digest": {
        title = "Base Ecosystem Digest";
        summary = resp.headline ?? "Daily Base ecosystem digest.";
        const movers = Array.isArray(resp.movers) ? resp.movers : [];
        const narrs = Array.isArray(resp.narratives) ? resp.narratives : [];
        metrics = clean([metric("Movers", movers.length ? `${movers.length}` : null), metric("Top mover", movers[0]?.token ?? movers[0]?.symbol ?? null), metric("Narratives", narrs.length ? `${narrs.length}` : null)]);
        break;
      }
      case "new-pools": {
        title = "New Pools on Base";
        const pools = Array.isArray(resp.pools) ? resp.pools : Array.isArray(resp.new_pools) ? resp.new_pools : [];
        const flagged = pools.filter((p: Any) => p?.honeypot || p?.flagged || p?.honeypotFlag).length;
        summary = pools.length ? `${pools.length} new pool${pools.length !== 1 ? "s" : ""} on Base${flagged ? ` · ${flagged} flagged 🚨` : ""}.` : "Scanning Base for new pools.";
        metrics = clean([metric("New pools", pools.length ? `${pools.length}` : null), metric("Top", pools[0]?.symbol ?? pools[0]?.baseSymbol ?? null), metric("Flagged", flagged ? `${flagged} 🚨` : null)]);
        break;
      }
      case "blue-stream": {
        title = "Base Onchain Activity";
        const trending = Array.isArray(resp.trending) ? resp.trending : [];
        const fresh = Array.isArray(resp.new_pools) ? resp.new_pools : [];
        summary = `Live Base activity — ${trending.length} trending · ${fresh.length} new pools.`;
        metrics = clean([metric("Trending", trending.length ? `${trending.length}` : null), metric("New pools", fresh.length ? `${fresh.length}` : null), metric("Top", trending[0]?.token ?? trending[0]?.symbol ?? null)]);
        break;
      }
      case "token-momentum-scanner": {
        title = "Base Momentum Scan";
        const plays = Array.isArray(resp.momentum_plays) ? resp.momentum_plays : [];
        summary = resp.summary ?? (plays[0]?.token ? `Top setup: ${plays[0].token}. Market ${resp.market_phase ?? "—"}.` : `Momentum scan — market ${resp.market_phase ?? "—"}.`);
        metrics = clean([metric("Market", typeof resp.market_phase === "string" ? resp.market_phase : null), metric("Plays", plays.length ? `${plays.length}` : null), metric("Top", plays[0]?.token ?? null)]);
        break;
      }
      case "narrative-position": {
        title = "Narrative Positions";
        const arr = Array.isArray(resp.narratives) ? resp.narratives : [];
        summary = resp.top_opportunity ? `Top: ${typeof resp.top_opportunity === "string" ? resp.top_opportunity : (resp.top_opportunity?.name ?? "")}` : (arr[0]?.name ? `Watching ${arr.length} narratives.` : "Narrative position map updated.");
        metrics = clean([metric("Narratives", arr.length ? `${arr.length}` : null), metric("Top", arr[0]?.name ?? null), metric("Call", arr[0]?.position_call ?? null)]);
        break;
      }
      case "defi-opportunity": {
        title = "DeFi Opportunities on Base";
        const opps = Array.isArray(resp.opportunities) ? resp.opportunities : [];
        summary = resp.summary ?? (opps[0]?.protocol ? `Best: ${opps[0].protocol}${opps[0].apy ? ` · ${opps[0].apy} APY` : ""}.` : "Base DeFi opportunity scan.");
        metrics = clean([metric("Opps", opps.length ? `${opps.length}` : null), metric("Top APY", opps[0]?.apy ? `${opps[0].apy}` : null), metric("Risk", opps[0]?.risk ?? null)]);
        break;
      }
      case "bankr-pulse": {
        title = "Bankr Trending";
        const trending = Array.isArray(resp.trending) ? resp.trending : [];
        const price    = resp.bnkr_price;
        const change   = resp.bnkr_change;
        summary = resp.summary ?? (trending[0]?.symbol
          ? `Trending on Bankr: ${trending.slice(0, 3).map((t: Any) => t.symbol).filter(Boolean).join(" · ")}`
          : "Bankr ecosystem pulse updated.");
        metrics = clean([
          metric("$BNKR",    price  != null ? fmtUsd(price)  : null),
          metric("24h",      change != null ? fmtPct(change) : null),
          metric("Launches", resp.metrics?.total_launches != null ? `${resp.metrics.total_launches}` : null),
        ]);
        break;
      }
      case "b20-tracker": {
        title = resp.title ?? "B20 on Base";
        const tracked = Array.isArray(resp.tracked) ? resp.tracked : [];
        summary = resp.summary ?? "B20 tracking on Base.";
        metrics = clean([
          metric("Tracked", tracked.length ? `${tracked.length}` : null),
          metric("Beryl",   resp.berylActive ? "LIVE" : (resp.daysToBeryl != null ? `${resp.daysToBeryl}d` : null)),
          metric("Top",     tracked[0]?.symbol ?? null),
        ]);
        break;
      }

      // ── Blue Feed v2 scan tools ─────────────────────────────────────────────

      case "base-token-scan": {
        title = "Base Token Signals";
        const sigs = Array.isArray(resp.signals) ? resp.signals : [];
        const top  = sigs[0];
        summary = sigs.length
          ? `${sigs.length} signal${sigs.length !== 1 ? "s" : ""} passed all 5 filters. Top: ${top?.symbol ?? "—"} ${top?.change_24h != null ? `(${top.change_24h > 0 ? "+" : ""}${top.change_24h.toFixed(1)}% 24h)` : ""}.`
          : "Scan complete — no tokens passed quality filters.";
        metrics = clean([
          metric("Signals", sigs.length ? `${sigs.length}` : null),
          metric("Top", top?.symbol ?? null),
          metric("24h", top?.change_24h != null ? `${top.change_24h > 0 ? "+" : ""}${top.change_24h.toFixed(1)}%` : null),
        ]);
        break;
      }
      case "defi-yield-scan": {
        title = "DeFi Yield Scan";
        const opps = Array.isArray(resp.opportunities) ? resp.opportunities : [];
        summary = opps.length
          ? `Top yield on Base: ${opps[0]?.protocol ?? "—"} ${opps[0]?.symbol ?? ""} at ${opps[0]?.apy != null ? `${opps[0].apy}% APY` : "—"}. ${opps.length} opportunities found.`
          : "No Base yield pools passed filters this scan.";
        metrics = clean([
          metric("Top APY",   opps[0]?.apy != null ? `${opps[0].apy}%` : null),
          metric("Protocol",  opps[0]?.protocol ?? null),
          metric("Pools",     opps.length ? `${opps.length}` : null),
        ]);
        break;
      }
      case "narrative-scan": {
        title = "Narrative Scan";
        const narrs = Array.isArray(resp.narratives) ? resp.narratives : [];
        const top   = narrs[0];
        const fading = narrs.filter((n: Any) => n.phase === "Fading");
        summary = top?.name
          ? `${top.name} (${top.phase ?? "—"}) leading on Base.${narrs.length > 1 ? ` Also: ${narrs.slice(1, 3).map((n: Any) => n.name).join(", ")}.` : ""}${fading.length ? ` Fading: ${fading.map((n: Any) => n.name).join(", ")}.` : ""}`
          : "Narrative scan complete.";
        metrics = clean([
          metric("Top",    top?.name ?? null),
          metric("Phase",  top?.phase ?? null),
          metric("Active", narrs.filter((n: Any) => n.phase !== "Fading").length ? `${narrs.filter((n: Any) => n.phase !== "Fading").length}` : null),
        ]);
        break;
      }
      case "picks-check": {
        title = "Signal Accuracy";  // "accuracy" not "track record" — filter correctness, not investment returns
        const tr = resp.track_record as Any;
        summary = tr?.win_rate != null
          ? `Filter direction correct ${tr.win_rate}% of the time across ${tr.total ?? 0} signals (22h check). Not financial advice.`
          : `${resp.checked ?? 0} signals evaluated.`;
        metrics = clean([
          metric("Accuracy", tr?.win_rate != null ? `${tr.win_rate}%` : null),
          metric("W/L",     (tr?.wins != null && tr?.losses != null) ? `${tr.wins}W / ${tr.losses}L` : null),
          metric("Signals",  tr?.total != null ? `${tr.total}` : null),
        ]);
        break;
      }
    }
  } catch { /* defaults */ }

  if (metrics.length === 0) {
    metrics = clean(Object.entries(resp ?? {})
      .filter(([k, v]) => typeof v !== "object" && v != null && !["tool", "timestamp", "disclaimer", "dataSource"].includes(k))
      .map(([k, v]) => metric(k.replace(/_/g, " "), String(v))));
  }
  if (!summary) summary = "Updated.";

  const shareText = `${title} — ${summary} via @blueagent_ blueagent.dev/app/feed`;
  const itemType: FeedItem["itemType"] =
    job.tool === "base-token-scan" ? "signal" :
    job.tool === "picks-check"     ? "track"  :
    job.tool === "narrative-scan"  ? "watch"  :
    "info";
  return { id: `${job.tool}-${cycleId}`, tool: job.tool, timestamp: ts, cycleId, agent: job.agent, title, summary, itemType, data: { metrics, raw: resp }, shareText };
}

async function callTool(job: Job, cycleId: number): Promise<FeedItem | null> {
  try {
    const res = await fetch(`${BASE_URL}/${job.tool}`, {
      method: "POST",
      headers: internalX402Headers(),
      body: JSON.stringify(job.body),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) { console.warn(`[feed] ${job.tool} → HTTP ${res.status}`); return null; }
    const data = await res.json().catch(() => null);
    if (!data || data.error) { console.warn(`[feed] ${job.tool} → no data / error`); return null; }
    // _noCard means the tool ran cleanly but produced nothing worth showing.
    if (data._noCard) { console.info(`[feed] ${job.tool} → silent (nothing passed filters)`); return null; }
    return toFeedItem(job, data, cycleId, 0);
  } catch (e) {
    console.warn(`[feed] ${job.tool} failed:`, (e as Error).message);
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawOf(item: FeedItem | undefined): Any { return (item?.data as { raw?: Any })?.raw ?? {}; }
function metricOf(item: FeedItem | undefined, re: RegExp): string | null {
  const ms = (item?.data as { metrics?: Metric[] })?.metrics ?? [];
  return ms.find((m) => re.test(m.label))?.value ?? null;
}

function deriveContext(items: FeedItem[]): CycleContext {
  const bp = items.find((i) => i.tool === "base-pulse");
  const ba = items.find((i) => i.tool === "base-alpha");
  return {
    tvl: metricOf(ba, /tvl/i) ?? metricOf(bp, /tvl/i),
    sentiment: metricOf(bp, /sentiment/i),
    pulse: metricOf(bp, /pulse|score/i),
  };
}

const STABLES = new Set(["WETH", "ETH", "USDC", "USDBC", "USDT", "DAI", "USD+", "USDS", "GHO", "WBTC", "CBETH", "CBBTC", "WSTETH"]);
function validTicker(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = x.trim().replace(/^\$/, "").toUpperCase();
  return /^[A-Z0-9]{2,12}$/.test(t) ? t : null;
}

/** Derive a rotating token for token-alpha — the cycle's top mover by volume.
 *  Prefer base-pulse top_tokens (volume-sorted), skip WETH/stablecoins; then
 *  base-alpha momentum picks; finally AERO. */
function topTokenFrom(items: FeedItem[]): string {
  const bp = rawOf(items.find((i) => i.tool === "base-pulse"));
  for (const t of Array.isArray(bp?.top_tokens) ? bp.top_tokens : []) {
    const tk = validTicker(t?.symbol); if (tk && !STABLES.has(tk)) return tk;
  }
  const ba = rawOf(items.find((i) => i.tool === "base-alpha"));
  for (const p of Array.isArray(ba?.momentum_picks) ? ba.momentum_picks : []) {
    const tk = validTicker(p?.symbol); if (tk && !STABLES.has(tk)) return tk;
  }
  return "AERO";
}

/** Run one feed cycle: snapshot once, share context, dedup, store. */
// `total` is `number | null`: null means the feed read failed and nothing was
// written, which is NOT the same as a feed that legitimately holds 0 items.
export async function runCycle(jobs: Job[]): Promise<{ ok: boolean; added: number; total: number | null; cycleId: number; token?: string }> {
  const cycleId = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

  // token-alpha + whale-tracker run AFTER context tools to use the cycle's top mover.
  const tokenJobs = jobs.filter((j) => j.tool === "token-alpha");
  const whaleJobs = jobs.filter((j) => j.tool === "whale-tracker");
  const otherJobs = jobs.filter((j) => j.tool !== "token-alpha" && j.tool !== "whale-tracker");

  const otherResults = (await Promise.all(otherJobs.map((j) => callTool(j, cycleId)))).filter((x): x is FeedItem => x !== null);

  // After base-token-scan runs, store its signals as pending picks for picks-check.
  const scanResult = otherResults.find((r) => r.tool === "base-token-scan");
  if (scanResult) {
    const raw = (scanResult.data as { raw?: Any })?.raw ?? {};
    const signals: Array<Any> = Array.isArray(raw.signals) ? raw.signals : [];
    if (signals.length > 0) {
      const now         = Date.now();
      const CHECK_DELAY = 22 * 3_600_000; // 22 hours

      // #150 A-part2 — the dedup read and the write target the SAME key, so a
      // throttled read used to drop every pick still waiting out its 22h
      // window and replace them with this cycle's. Those picks ARE the
      // pick track record: losing them doesn't just lose data, it silently
      // biases the record by deleting open positions before they can grade.
      const picksRes = await kvMutate<PendingPick[]>("feed:picks:pending", [], (existing) => {
        const existingSyms = new Set(existing.map((p) => p.symbol.toUpperCase()));
        const newPicks: PendingPick[] = signals
          .filter((s) => s.symbol && !existingSyms.has(String(s.symbol).toUpperCase()))
          .map((s) => ({
            symbol:          String(s.symbol),
            price_at_signal: typeof s.price_usd === "number" ? s.price_usd : null,
            signal_ts:       now,
            check_after:     now + CHECK_DELAY,
            volume_24h:      typeof s.volume_24h === "number" ? s.volume_24h : null,
            liquidity_usd:   typeof s.liquidity_usd === "number" ? s.liquidity_usd : null,
          }));
        if (newPicks.length === 0) return null; // nothing new — write nothing
        return [...existing, ...newPicks];
      }, 7 * 24 * 3600);
      if (picksRes === "skipped") {
        console.error("[feed] pending picks NOT appended — KV read failed; this cycle's signals are not tracked");
      }
    }
  }

  const topToken = topTokenFrom(otherResults);

  let token: string | undefined;
  let tokenResults: FeedItem[] = [];
  if (tokenJobs.length) {
    token = topToken;
    tokenResults = (await Promise.all(tokenJobs.map((j) => callTool({ ...j, body: { token } }, cycleId)))).filter((x): x is FeedItem => x !== null);
  }

  // whale-tracker uses top mover address from base-pulse top_tokens
  let whaleResults: FeedItem[] = [];
  if (whaleJobs.length) {
    // topTokenFrom returns symbol — get address from base-pulse top_tokens
    const bp = otherResults.find((r) => r.tool === "base-pulse");
    const topAddr = Array.isArray((bp?.data as Record<string, unknown>)?.top_tokens)
      ? ((bp?.data as Record<string, unknown>).top_tokens as Array<{address?: string; token?: string}>)
          .find((t) => t.token === topToken || t.address)?.address
      : undefined;
    whaleResults = (await Promise.all(whaleJobs.map((j) => callTool(
      topAddr ? { ...j, body: { address: topAddr } } : j,
      cycleId
    )))).filter((x): x is FeedItem => x !== null);
  }

  const fresh = [...otherResults, ...whaleResults, ...tokenResults];
  const context = deriveContext(fresh);
  fresh.forEach((it) => { (it.data as Record<string, unknown>).context = context; });

  await kvSet(`feed:cycle:${cycleId}:context`, context);

  // dedup: drop any existing item for (cycleId, tool) we just refreshed
  // #150 A-part2 — same key read and written. A throttled read truncated the
  // whole 80-item feed down to this one cycle's items.
  const freshKeys = new Set(fresh.map((f) => `${f.cycleId}:${f.tool}`));
  let total: number | null = null;

  const itemsRes = await kvMutate<FeedItem[]>("feed:items", [], (existing) => {
    const kept   = existing.filter((e) => !freshKeys.has(`${e.cycleId ?? 0}:${e.tool}`));
    const merged = [...fresh, ...kept].slice(0, 80);
    total = merged.length;
    return merged;
  });
  if (itemsRes === "skipped") console.error("[feed] items NOT written — KV read failed; feed left untouched");

  // `total` is null when the write was skipped — the caller must be able to
  // tell "feed has 0 items" from "we could not read the feed".
  return { ok: itemsRes !== "skipped", added: fresh.length, total, cycleId, token };
}

/** Returns an error Response if auth fails, else null. Caller passes the Request. */
export function authError(req: Request): { status: number; body: Record<string, unknown> } | null {
  const authHeader  = req.headers.get("authorization");
  const secretParam = new URL(req.url).searchParams.get("secret");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}` && secretParam !== CRON_SECRET) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  if (!hasInternalKey()) {
    return { status: 500, body: { error: "INTERNAL_SERVICE_KEY not configured" } };
  }
  return null;
}
