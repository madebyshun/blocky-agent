/**
 * dex-anchor-check — every DEX price we publish must be denominated in dollars.
 *
 * ── What this asserts ──────────────────────────────────────────────────────
 * For every ticker the Blue Hood engine polls, on BOTH chains, it calls the real
 * production `dexPrice()` and then independently asks: *what is the pool it
 * picked actually made of?* If the side of that pool which is NOT our token is
 * not a USD-anchored asset, the price is an exchange rate against an arbitrary
 * token being published as a share price. That is a FAIL.
 *
 * ── Why this exists (#223) ─────────────────────────────────────────────────
 * Both readers in `rwa-price.ts` used to sort candidate pools by depth and take
 * `[0]`, with nothing asking what the pool was priced against. Depth is not a
 * safety property: a deep pool against a memecoin is still a deep pool. MEASURED
 * 2026-09-08, pre-fix:
 *
 *   Base  TSLAc  → TSLAc/STC (uniswap, $263,690 liq) = $14,308.89, a 39.5×
 *                  overstatement of a ~$362 share. Wrong PRICE, because
 *                  DexScreener derives `priceUsd` from the winning pair.
 *   RH    NVDA   → "AI / NVDA" ($21.9M liq, $3.2M vol) instead of NVDA/USDG
 *                  ($6.4M liq, $31.9M vol). Price survived (GeckoTerminal
 *                  computes it independently) but liquidity was 3.4× too high
 *                  and 24h volume 10× too LOW — and those two fields feed the
 *                  dead-pool liveness gate in `rule-engine.ts`, the gate that
 *                  decides whether an arrow may fire at all.
 *
 * Eight of 24 RH tickers were priced on a pool whose metadata belonged to some
 * other token. This had already happened; it was not a hypothetical.
 *
 * ── Why the table below is duplicated and MUST STAY duplicated ─────────────
 * `ANCHOR_ASSETS` in `rwa-price.ts` is the rule production applies. This file
 * asks whether production's OUTPUT obeys it. Importing the constant would make
 * the check assert production against production's own definition — a tautology
 * that can never fail, no matter how wrong the rule itself became. Writing the
 * addresses out again is the entire test. Same reasoning as `saneBand` (wide
 * production backstop) vs `SANE_BAND` (tight independent acceptance test) in the
 * Base-stocks registry, and as gate 4b in `base-stock-admission-probe.ts`.
 *
 * If you are here because this check failed and you are tempted to add an
 * address to the table to make it pass: that is the wrong direction. Add it to
 * `ANCHOR_ASSETS` first, deliberately, and only if the asset genuinely has deep
 * external price discovery that a single pool cannot fake.
 *
 * ── A null price is NOT a failure — but there are two kinds of null ────────
 * A ticker with no anchored pool returns null and surfaces as `dex_unavailable`
 * (#140). That is the honest answer for a token with no dollar market, so it is
 * reported but does not fail the run. What WOULD be a regression is the desk
 * going broadly dark, so the null count is printed prominently.
 *
 * `dark` and `unverified` are kept apart on purpose. GeckoTerminal's free tier
 * 429s readily, and a 429 also returns null — so without the split, a throttled
 * run reads as a healthy-but-quiet desk and a real desk-wide blanking is
 * indistinguishable from a bad minute at the provider. See `captureMiss`.
 *
 * Usage:  npx tsx scripts/dex-anchor-check.ts [--chain base|rh|both]
 * Exit:   0 = every published price is dollar-denominated; 1 = at least one is not.
 */
import {
  dexPrice,
  BASE_PRICE_SOURCE,
  RH_PRICE_SOURCE,
} from "@/lib/robinhood/rwa-price";
import { BASE_STOCKS } from "@/lib/base-stocks/registry";
import { HOOD_WATCHLIST } from "@/lib/blue-hood/registry";
import type { Address } from "viem";

// ── INDEPENDENT anchor table. Do NOT import this from rwa-price.ts. ──────────
// Addresses verified on their own chain's explorer; a ticker/symbol string is
// never sufficient to identify a token (a counterfeit reports the same symbol
// AND the same name — measured on TSLAc, 2026-09-08).
const ANCHORS: Record<"base" | "rh", Record<string, string>> = {
  base: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
    "0x4200000000000000000000000000000000000006": "WETH",
  },
  rh: {
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG",
    "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "WETH",
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Pairing = { a: string; aSym: string; b: string; bSym: string; label: string };

/** Independently re-read a Base pool BY ADDRESS. Production asked "which pool
 *  for this token?"; this asks "what is that pool made of?" — a different
 *  question against a different endpoint. */
async function basePairing(pool: string): Promise<Pairing | null> {
  for (let i = 0; i < 4; i++) {
    if (i > 0) await sleep(1500 * 2 ** (i - 1));
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/pairs/base/${pool.toLowerCase()}`,
        { headers: { accept: "application/json", "user-agent": "blue-agent/1.0 (+https://blueagent.dev)" } },
      );
      if (res.status === 429 || res.status >= 500) continue;
      if (!res.ok) return null;
      const j = (await res.json()) as {
        pairs?: { baseToken?: { address?: string; symbol?: string }; quoteToken?: { address?: string; symbol?: string }; dexId?: string }[] | null;
      };
      const p = j.pairs?.[0];
      if (!p?.baseToken?.address || !p?.quoteToken?.address) return null;
      return {
        a: p.baseToken.address.toLowerCase(), aSym: p.baseToken.symbol ?? "?",
        b: p.quoteToken.address.toLowerCase(), bSym: p.quoteToken.symbol ?? "?",
        label: `${p.baseToken.symbol ?? "?"}/${p.quoteToken.symbol ?? "?"} @ ${p.dexId ?? "?"}`,
      };
    } catch { /* network blip — retry */ }
  }
  return null;
}

/** Same, for a Robinhood Chain pool via GeckoTerminal. GT rate-limits hard on
 *  the free tier, so 429 backs off and ultimately returns null (→ reported as
 *  UNVERIFIED, never as a violation — a rate limit is not evidence of a bug). */
async function rhPairing(pool: string): Promise<Pairing | null> {
  for (let i = 0; i < 5; i++) {
    if (i > 0) await sleep(4000 * i);
    try {
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool.toLowerCase()}`,
        { headers: { accept: "application/json" } },
      );
      if (res.status === 429 || res.status >= 500) continue;
      if (!res.ok) return null;
      const j = (await res.json()) as {
        data?: { attributes?: { name?: string }; relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } } };
      };
      const strip = (id?: string) => (id ? (id.startsWith("robinhood_") ? id.slice(10) : id).toLowerCase() : "");
      const a = strip(j.data?.relationships?.base_token?.data?.id);
      const b = strip(j.data?.relationships?.quote_token?.data?.id);
      if (!a || !b) return null;
      return { a, aSym: "?", b, bSym: "?", label: j.data?.attributes?.name ?? "?" };
    } catch { /* retry */ }
  }
  return null;
}

type Row = {
  chain: "base" | "rh"; ticker: string; token: string;
  verdict: "ok" | "VIOLATION" | "unverified" | "no-price";
  detail: string;
};

/**
 * `dexPrice` returns null for EVERY failure mode — rate limit, unindexed token,
 * and "no anchored pool" all look identical to the caller. Collapsing them here
 * would be the bug this whole family is about: a throttled run would read as a
 * healthy-but-quiet desk, and a regression that genuinely blanked the desk would
 * be indistinguishable from GeckoTerminal having a bad minute. MEASURED on the
 * first pre-fix run of this script: 7 of 7 "dark" rows were `http=429`.
 *
 * The discriminator already exists — `logDexMiss` writes the reason to
 * console.warn. So capture that line rather than guess. A 429 becomes
 * `unverified` (not a failure, not a clean bill of health either); only
 * `unanchored`/`pools=0` is a genuine dark.
 */
function captureMiss(): { read: () => string | null; restore: () => void } {
  const orig = console.warn;
  let last: string | null = null;
  console.warn = (...args: unknown[]) => {
    const s = args.map(String).join(" ");
    if (s.startsWith("[dex-price] MISS")) { last = s; return; } // swallow: we report it ourselves
    orig(...(args as []));
  };
  return { read: () => { const v = last; last = null; return v; }, restore: () => { console.warn = orig; } };
}

async function checkChain(chain: "base" | "rh"): Promise<Row[]> {
  const anchors = ANCHORS[chain];
  const list = chain === "base"
    ? BASE_STOCKS.map((s) => ({ ticker: s.ticker, token: s.token as Address }))
    : HOOD_WATCHLIST.map((t) => ({ ticker: t.ticker, token: t.contract as Address }));
  const source = chain === "base" ? BASE_PRICE_SOURCE : RH_PRICE_SOURCE;
  const pairingOf = chain === "base" ? basePairing : rhPairing;
  // Each ticker costs TWO provider calls (dexPrice + the independent pool
  // re-read). GT's free tier needs real spacing or half the run 429s and the
  // result is noise; DexScreener's quota is far looser.
  const gap = chain === "base" ? 1200 : 10_000;

  const rows: Row[] = [];
  const miss = captureMiss();
  for (const { ticker, token } of list) {
    const q = await dexPrice(token, source);
    if (!q || !q.pool_address) {
      const why = miss.read() ?? "(no diagnostic emitted)";
      // A transport failure is NOT evidence about the anchor rule. Only an
      // actual "every pool was unanchored / token not indexed" answer is.
      const transport = /http=(429|5\d\d)|throw=/.test(why);
      rows.push({
        chain, ticker, token,
        verdict: transport ? "unverified" : "no-price",
        detail: transport
          ? `provider failure, anchor rule NOT exercised — ${why.replace(/^\[dex-price\] MISS\s*/, "")}`
          : `dex_unavailable — ${why.replace(/^\[dex-price\] MISS\s*/, "")}`,
      });
      await sleep(gap);
      continue;
    }
    miss.read();
    const pair = await pairingOf(q.pool_address);
    if (!pair) {
      rows.push({ chain, ticker, token, verdict: "unverified", detail: `could not re-read pool ${q.pool_address} (rate limit / not indexed)` });
      await sleep(gap);
      continue;
    }
    const self = token.toLowerCase();
    // Symmetric: whichever side is not ours is the asset we are quoting in.
    const counter = pair.a === self ? pair.b : pair.a;
    if (pair.a !== self && pair.b !== self) {
      rows.push({ chain, ticker, token, verdict: "VIOLATION", detail: `priced on ${pair.label} (${q.pool_address}) which contains NEITHER side matching ${self}` });
    } else if (!anchors[counter]) {
      rows.push({ chain, ticker, token, verdict: "VIOLATION", detail: `priced on ${pair.label} — quoted against ${counter}, not a USD anchor. $${q.price_usd} is an exchange rate, not a share price. liq=$${q.liquidity_usd?.toLocaleString() ?? "?"} vol24h=$${q.volume_24h_usd?.toLocaleString() ?? "?"}` });
    } else {
      rows.push({ chain, ticker, token, verdict: "ok", detail: `${pair.label} vs ${anchors[counter]} — $${q.price_usd}` });
    }
    await sleep(gap);
  }
  miss.restore();
  return rows;
}

async function main() {
  const argIdx = process.argv.indexOf("--chain");
  const want = argIdx >= 0 ? process.argv[argIdx + 1] : "both";
  const chains: ("base" | "rh")[] = want === "base" ? ["base"] : want === "rh" ? ["rh"] : ["base", "rh"];

  console.log("dex-anchor-check — is every published DEX price denominated in dollars?\n");
  const rows: Row[] = [];
  for (const c of chains) {
    console.log(`── ${c === "base" ? "Base 8453" : "Robinhood Chain 4663"} ${"─".repeat(52)}`);
    const r = await checkChain(c);
    for (const x of r) {
      const mark = x.verdict === "ok" ? "  ok  " : x.verdict === "VIOLATION" ? " FAIL " : x.verdict === "unverified" ? " ???? " : " dark ";
      console.log(`[${mark}] ${x.ticker.padEnd(7)} ${x.detail}`);
    }
    rows.push(...r);
    console.log("");
  }

  const bad = rows.filter((r) => r.verdict === "VIOLATION");
  const dark = rows.filter((r) => r.verdict === "no-price");
  const unk = rows.filter((r) => r.verdict === "unverified");
  console.log(`${"─".repeat(72)}`);
  console.log(`checked=${rows.length}  ok=${rows.filter((r) => r.verdict === "ok").length}  VIOLATION=${bad.length}  dark=${dark.length}  unverified=${unk.length}`);
  if (dark.length) console.log(`dark (rule applied, no anchored pool — honest, but watch the count): ${dark.map((d) => `${d.chain}:${d.ticker}`).join(", ")}`);
  if (unk.length) console.log(`unverified (provider failed; the rule was never exercised — NOT a pass and NOT a failure): ${unk.map((d) => `${d.chain}:${d.ticker}`).join(", ")}`);

  if (bad.length) {
    console.log(`\n🔴 ${bad.length} price(s) are not dollar-denominated:`);
    for (const b of bad) console.log(`   ${b.chain}:${b.ticker} — ${b.detail}`);
    process.exit(1);
  }
  console.log("\n✅ every published DEX price is quoted against a USD-anchored asset.");
}

main().catch((e) => { console.error(e); process.exit(1); });
