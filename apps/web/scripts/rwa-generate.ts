/**
 * rwa-generate — rebuild the RWA_TOKENS rows of `src/lib/robinhood/rwa-registry.ts`
 * from the RHJ factory's own `Deployed` events.
 *
 *   npx tsx scripts/rwa-generate.ts            # print the block to stdout
 *   npx tsx scripts/rwa-generate.ts --write    # splice it into the registry
 *
 * ── Why the factory log, and not the token list ────────────────────────────
 * Two earlier passes at this file enumerated tokens through Blockscout
 * `/api/v2/tokens?type=ERC-20`, then kept the rows whose `creator_address_hash`
 * matched RH_RWA_DEPLOYER. That is sound logic pointed at the wrong index:
 * `/tokens` is sorted by market cap and serves a fixed 50-row page (it accepts
 * a `limit` param and ignores it — measured at 50/100/200). So the sweep only
 * ever saw tokens that already had a market cap, and a genuine RHJ deployment
 * with no pool yet — precisely the "new listing" case the registry exists to
 * catch — sorted below the cutoff and was invisible. That is how the file came
 * to hold 26 rows, then 96, while the chain held 203.
 *
 * `RH_RWA_DEPLOYER` is not an EOA. It is an ERC1967Proxy factory, and every
 * canonical token is born from a `deploy` call on it that emits:
 *
 *     Deployed(bytes32 indexed uid, address stock, string name, string symbol)
 *
 * Enumerating those logs is complete (an event cannot be ranked out of a list),
 * cheap (one paginated endpoint, no per-token creator lookup), and
 * impersonation-proof by construction — a contract cannot emit another
 * contract's events, so membership in this list *is* the provenance proof that
 * `creator == RH_RWA_DEPLOYER` was being used to approximate. The fake GME
 * (0x1c8a973a…, 2,362 holders) came out of thirdweb's TWCloneFactory and can
 * never appear here.
 *
 * ── What is generated vs. what is preserved ────────────────────────────────
 * Address, symbol, decimals and on-chain name come from the chain every run.
 * `name` / `sector` / `note` are hand-written display columns: when a row
 * already exists in the registry, its curated values are carried over verbatim
 * and the on-chain name is ignored. New rows get the on-chain name with the
 * " • Robinhood Token" suffix stripped and NO sector — an invented sector is a
 * fabricated fact, and `sector` is a filter key several rh-* tools group by.
 */
import { createPublicClient, http, getAddress, parseAbi } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  RH_CHAIN,
  RH_RWA_DEPLOYER,
  RWA_TOKENS,
  type RwaToken,
} from "../src/lib/robinhood/rwa-registry";

const BS = `${RH_CHAIN.explorer}/api/v2`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(HERE, "../src/lib/robinhood/rwa-registry.ts");
const FEEDS_URL =
  "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";

/** Suffix every RHJ token carries; stripped for the display `name` column. */
const NAME_SUFFIX = " • Robinhood Token";
/** Pagination ceiling — 30 × 50 is ~7× the current deployment count. */
const MAX_PAGES = 30;
/** RH Chain has no Multicall3 yet, so decimals() is one eth_call per token. */
const RPC_CONCURRENCY = 8;

const client = createPublicClient({
  chain: {
    id: RH_CHAIN.chainId,
    name: RH_CHAIN.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RH_CHAIN.rpc] } },
  },
  transport: http(RH_CHAIN.rpc),
});

const erc20 = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

type Deployment = { contract: `0x${string}`; onchainName: string; symbol: string; block: number };

/** Walk every `Deployed` event the factory has ever emitted. */
async function crawlFactory(): Promise<Deployment[]> {
  const seen = new Map<string, Deployment>();
  let next: Record<string, unknown> | null = null;
  let pages = 0;

  for (let p = 0; p < MAX_PAGES; p++) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next ?? {})) if (v != null) qs.set(k, String(v));
    const r = await fetch(`${BS}/addresses/${RH_RWA_DEPLOYER}/logs?${qs}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      throw new Error(
        `Blockscout returned ${r.status} on factory logs page ${p}. Refusing to ` +
          `write a registry from a partial crawl — re-run when the explorer is healthy.`,
      );
    }
    const d = (await r.json()) as {
      items?: { decoded?: { method_call?: string; parameters?: { name: string; value: string }[] }; block_number?: number }[];
      next_page_params?: Record<string, unknown> | null;
    };
    pages++;
    for (const l of d.items ?? []) {
      if (!l.decoded?.method_call?.startsWith("Deployed(")) continue;
      const get = (n: string) => l.decoded?.parameters?.find((x) => x.name === n)?.value;
      const stock = get("stock");
      const symbol = get("symbol");
      const name = get("name");
      if (!stock || !symbol) continue;
      // Keyed by address so a re-emitted uid can never duplicate a row.
      seen.set(stock.toLowerCase(), {
        contract: getAddress(stock),
        onchainName: name ?? "",
        symbol,
        block: l.block_number ?? 0,
      });
    }
    next = (d.next_page_params as Record<string, unknown> | null) ?? null;
    if (!next || (d.items ?? []).length === 0) break;
  }

  if (pages >= MAX_PAGES) {
    throw new Error(`hit MAX_PAGES (${MAX_PAGES}) — raise it, the crawl was truncated`);
  }
  return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** ticker → Chainlink /USD proxy, for the equity feeds RH Chain publishes. */
async function loadFeeds(): Promise<Map<string, { proxy: `0x${string}`; heartbeat: number }>> {
  const r = await fetch(FEEDS_URL, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Chainlink feed directory returned ${r.status}`);
  const feeds = (await r.json()) as {
    name?: string;
    proxyAddress?: string;
    docs?: { marketHours?: string };
    heartbeat?: number;
  }[];
  const out = new Map<string, { proxy: `0x${string}`; heartbeat: number }>();
  for (const f of feeds) {
    if (f.docs?.marketHours !== "us_equities_24/5") continue;
    if (!f.proxyAddress) continue;
    // Two spellings coexist in this file: "Robinhood SGOV-USD" and
    // "Robinhood EWY / USD". Both separators have to be stripped.
    const ticker = (f.name ?? "")
      .replace(/^Robinhood\s+/i, "")
      .replace(/\s*[/-]\s*USD$/i, "")
      .trim()
      .toUpperCase();
    if (!ticker || !/^[A-Z0-9.]+$/.test(ticker)) {
      throw new Error(`cannot derive a ticker from Chainlink feed name "${f.name}" — fix rwa-generate.ts`);
    }
    out.set(ticker, { proxy: getAddress(f.proxyAddress), heartbeat: f.heartbeat ?? 86400 });
  }
  return out;
}

function esc(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function serialize(t: RwaToken): string {
  const parts = [
    `ticker: "${esc(t.ticker)}",`.padEnd(16),
    `name: "${esc(t.name)}",`.padEnd(52),
    `contract: "${t.contract}",`,
    `decimals: ${t.decimals},`,
    `kind: "${t.kind}",`,
    `issuer: "${t.issuer}",`,
  ];
  if (t.sector) parts.push(`sector: "${esc(t.sector)}",`);
  if (t.chainlinkFeed) {
    parts.push(`chainlinkFeed: "${t.chainlinkFeed}",`, `chainlinkHeartbeat: ${t.chainlinkHeartbeat ?? 86400},`);
  }
  if (t.note) parts.push(`note: "${esc(t.note)}",`);
  return `  { ${parts.join(" ").replace(/,$/, "")} },`;
}

async function main() {
  const write = process.argv.includes("--write");

  console.error("crawling factory Deployed events…");
  const deployments = await crawlFactory();
  console.error(`  ${deployments.length} deployments`);

  console.error("loading Chainlink equity feeds…");
  const feeds = await loadFeeds();
  console.error(`  ${feeds.size} equity feeds`);

  console.error(`reading decimals() for ${deployments.length} tokens…`);
  const decimals = await pool(deployments, RPC_CONCURRENCY, async (d) => {
    try {
      return await client.readContract({ address: d.contract, abi: erc20, functionName: "decimals" });
    } catch {
      return null;
    }
  });
  const undecidable = deployments.filter((_, i) => decimals[i] == null);
  if (undecidable.length) {
    throw new Error(
      `decimals() failed for ${undecidable.length} token(s) (${undecidable
        .map((d) => d.symbol)
        .join(", ")}). Refusing to guess 18 — re-run.`,
    );
  }

  // Existing rows keep their curated display columns.
  const curated = new Map(RWA_TOKENS.map((t) => [t.contract.toLowerCase(), t]));
  const rows: RwaToken[] = deployments.map((d, i) => {
    const prev = curated.get(d.contract.toLowerCase());
    const ticker = d.symbol.toUpperCase();
    const feed = feeds.get(ticker);
    const onchain = d.onchainName.endsWith(NAME_SUFFIX)
      ? d.onchainName.slice(0, -NAME_SUFFIX.length)
      : d.onchainName;
    return {
      ticker,
      name: prev?.name ?? onchain,
      contract: d.contract,
      decimals: decimals[i]!,
      // ETF-ness is read off the on-chain name, the only signal the chain
      // gives. A fund that doesn't say so in its name lands in "stock" — a
      // display miscategorisation, never a wrong address.
      kind: prev?.kind ?? (/\bETF\b|\bTrust\b|\bFund\b/i.test(onchain) ? "etf" : "stock"),
      issuer: "RHJ",
      ...(prev?.sector ? { sector: prev.sector } : {}),
      ...(feed ? { chainlinkFeed: feed.proxy, chainlinkHeartbeat: feed.heartbeat } : {}),
      ...(prev?.note ? { note: prev.note } : {}),
    };
  });

  // Utility rows are not factory output (different issuers, by design) and are
  // carried through untouched.
  const utility = RWA_TOKENS.filter((t) => t.kind === "stable" || t.kind === "wrapped");

  const stocks = rows.filter((r) => r.kind === "stock");
  const etfs = rows.filter((r) => r.kind === "etf");
  const withFeed = rows.filter((r) => r.chainlinkFeed).length;

  const block = [
    "export const RWA_TOKENS: RwaToken[] = [",
    "  // ── Stocks (US equities) ─────────────────────────────────────────────────",
    ...stocks.map(serialize),
    "",
    "  // ── ETFs ────────────────────────────────────────────────────────────────",
    ...etfs.map(serialize),
    "",
    "  // ── Utility / wrapped (not factory output — different issuers, by design) ─",
    ...utility.map(serialize),
    "];",
  ].join("\n");

  console.error(
    `\n${rows.length} RHJ rows (${stocks.length} stocks + ${etfs.length} ETFs) + ` +
      `${utility.length} utility · ${withFeed} with a Chainlink feed`,
  );
  const unmatched = [...feeds.keys()].filter((t) => !rows.some((r) => r.ticker === t));
  if (unmatched.length) console.error(`feeds with no token: ${unmatched.join(", ")}`);

  if (!write) {
    console.log(block);
    return;
  }

  const src = readFileSync(REGISTRY, "utf8");
  const start = src.indexOf("export const RWA_TOKENS: RwaToken[] = [");
  if (start < 0) throw new Error("could not find RWA_TOKENS in the registry");
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error("could not find the end of RWA_TOKENS");
  writeFileSync(REGISTRY, src.slice(0, start) + block + src.slice(end + 3));
  console.error(`\nwrote ${REGISTRY}`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${(e as Error).message}`);
  process.exit(1);
});
