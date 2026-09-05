/**
 * Wallet — regression guard: the Robinhood Chain leg is honest and partitioned.
 *
 * WHY THIS EXISTS
 * ---------------
 * The wallet read Base through Moralis and nothing else, so a holder of RH
 * Chain (4663) crypto saw their RH *stocks* and not their RH *tokens* — USDG
 * included, which is what that chain calls cash — with nothing on screen saying
 * a whole chain went unread. `rh-holdings.ts` closes that. The three properties
 * below are the ones that would rot SILENTLY, each for its own reason:
 *
 *   1. THE PARTITION is a coupling between two files with no compiler link.
 *      `stock-holdings.ts` keeps `kind` stock|etf and drops the rest as "cash
 *      and gas"; `rh-holdings.ts` drops exactly those and keeps the rest. Change
 *      one filter and the registry stops partitioning: a holding either appears
 *      in both tables — counted twice, the two tables then disagreeing about
 *      the same wallet — or in neither. Nothing about that fails to compile.
 *
 *   2. "COULD NOT READ" MUST NOT LOOK LIKE "HOLDS NOTHING". The entire point of
 *      the feature. A fail-soft that returns `[]` on a dead explorer is how a
 *      user concludes their position vanished, and it is one `.catch(() => [])`
 *      away at all times.
 *
 *   3. THE CHAT CARD MUST NOT DRIFT. `/api/chat` shares this reader through the
 *      fail-soft `getRobinhoodAddressBalances` wrapper. Pagination and retries
 *      are opt-in parameters precisely so chat keeps its old behaviour; a
 *      changed DEFAULT would silently add sequential explorer round-trips to
 *      every chat message that mentions a wallet.
 *
 * Network-free: `fetch` is stubbed, so this runs in the default suite. A test
 * that needs the live explorer would be a test that goes red when Blockscout
 * has a bad minute, which is noise, not signal.
 *
 * Run: npx tsx scripts/rh-holdings-check.ts
 */
import { RWA_TOKENS } from "../src/lib/robinhood/rwa-registry";

let failures = 0;
/** Counted, never hardcoded — a hand-maintained total goes stale the first
 *  time someone adds a check and forgets to bump it. */
let checks = 0;

function check(name: string, cond: boolean, detail = "") {
  checks++;
  if (cond) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── Fetch stub ───────────────────────────────────────────────────────────────
// Installed before the modules under test are imported, so nothing reaches the
// network. Each case decides what the explorer "is" for that call.
type Mode = "ok" | "dead" | "tokens-dead" | "paged";
let mode: Mode = "ok";
let calls: string[] = [];

const WALLET = "0x1A18a8b96eac3F980133A18402d04194f1FAA4E7";
const USDG   = RWA_TOKENS.find(t => t.ticker === "USDG")!;
const AAPL   = RWA_TOKENS.find(t => t.ticker === "AAPL")!;

const tokenRow = (addr: string, sym: string, dec: number, value: string, rate: string | null) =>
  ({ token: { address_hash: addr, name: sym, symbol: sym, decimals: String(dec), exchange_rate: rate }, value });

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});

globalThis.fetch = (async (input: unknown) => {
  const url = String(typeof input === "string" ? input : (input as { url?: string })?.url ?? "");
  calls.push(url);
  if (mode === "dead") return new Response("upstream down", { status: 503 });

  if (url.includes("/tokens?type=ERC-20")) {
    if (mode === "tokens-dead") return new Response("upstream down", { status: 503 });
    if (mode === "paged") {
      // Every page is full and always hands back another cursor, so the walk can
      // only end at the cap. Models the 450-row airdrop magnet measured on chain.
      const page = Number(new URL(url, "https://x").searchParams.get("id") ?? "0");
      return json({
        items: [tokenRow(`0x${String(page).padStart(40, "a")}`, `SPAM${page}`, 18, "1000000000000000000", null)],
        next_page_params: { id: page + 1, value: "1", items_count: 50 },
      });
    }
    return json({
      items: [
        tokenRow(USDG.contract, "USDG", USDG.decimals, "1000000", "1"),   //  1 USDG  @ $1
        tokenRow(AAPL.contract, "AAPL", AAPL.decimals, "2000000000000000000", "100"), // equity → stock table
      ],
      next_page_params: null,
    });
  }
  // /addresses/{a}
  return json({ coin_balance: "1000000000000000000", exchange_rate: "2000" }); // 1 ETH @ $2000
}) as typeof fetch;

async function main() {
  const { readRhHoldings } = await import("../src/lib/wallet/rh-holdings");
  const { getRobinhoodAddressBalances } = await import("../src/lib/robinhood/blockscout");

  // ── 1. The partition ───────────────────────────────────────────────────────
  // Asserted against the REGISTRY, not against a copy of the list, so adding a
  // ticker cannot drift the two tables apart.
  mode = "ok";
  const equities = RWA_TOKENS.filter(t => t.kind === "stock" || t.kind === "etf");
  const nonEquities = RWA_TOKENS.filter(t => t.kind !== "stock" && t.kind !== "etf");
  check("registry actually has both sides to partition",
    equities.length > 0 && nonEquities.length > 0,
    `${equities.length} equities / ${nonEquities.length} other`);

  const ok = await readRhHoldings(WALLET);
  const shown = new Set(ok.holdings.map(h => h.address.toLowerCase()));
  check("equity rows go to the STOCK table, not this one",
    !shown.has(AAPL.contract.toLowerCase()) && ok.equitiesHidden === 1,
    `equitiesHidden=${ok.equitiesHidden}`);
  check("a hidden equity is REPORTED, never silently swallowed", ok.equitiesHidden > 0);
  check("USDG is kept here — the stock leg drops it as 'cash'",
    shown.has(USDG.contract.toLowerCase()));
  check("no registry equity can appear in both tables",
    equities.every(t => !shown.has(t.contract.toLowerCase())));

  // Trust + total, on the same read: a scam token quoting its own price through
  // its own pool must not be able to set the number the wallet calls a portfolio.
  check("total counts only rows this app vouches for",
    Math.abs(ok.totalUsd - 2001) < 1e-6, `totalUsd=${ok.totalUsd}`);
  check("a pinned RH contract classifies as verified",
    ok.holdings.find(h => h.address.toLowerCase() === USDG.contract.toLowerCase())?.trust === "verified");

  // ── 2. "Could not read" ≠ "holds nothing" ──────────────────────────────────
  mode = "dead";
  const down = await readRhHoldings(WALLET);
  check("dead explorer → status 'unavailable', NOT an empty portfolio",
    down.status === "unavailable" && down.holdings.length === 0,
    `status=${down.status}`);

  const bad = await readRhHoldings("not-an-address");
  check("invalid address → 'unavailable' with a reason, never a zero portfolio",
    bad.status === "unavailable" && !!bad.error);

  // The ERC-20 list is what defines the portfolio; the native call failing on
  // its own leaves the token list perfectly real and the leg short by one row.
  mode = "tokens-dead";
  const half = await readRhHoldings(WALLET);
  check("token list dead → 'unavailable' even though native ETH answered",
    half.status === "unavailable");

  mode = "ok";
  check("native read OK → nativeUnread false", (await readRhHoldings(WALLET)).nativeUnread === false);

  // ── 3. Truncation is reported, and the chat card does not drift ────────────
  mode = "paged";
  calls = [];
  const long = await readRhHoldings(WALLET);
  check("hitting the page cap sets `truncated` — the list is short and says so",
    long.status === "ok" && long.truncated === true);
  const walletPages = calls.filter(u => u.includes("/tokens?type=ERC-20")).length;
  check("the walk is BOUNDED — a 450-row airdrop magnet cannot become 9 round-trips",
    walletPages > 1 && walletPages <= 5, `${walletPages} token-list requests`);

  calls = [];
  await getRobinhoodAddressBalances(WALLET);
  const chatPages = calls.filter(u => u.includes("/tokens?type=ERC-20")).length;
  check("chat's wrapper still reads exactly ONE page — pagination is opt-in",
    chatPages === 1, `${chatPages} token-list request(s)`);

  console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
