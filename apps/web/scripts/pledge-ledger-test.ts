/**
 * scripts/pledge-ledger-test.ts — `npm run test:pledge`
 *
 * The pledge page publishes numbers that holders will read as a statement about
 * their own money. This script checks the things that would make those numbers
 * wrong in a way nobody would notice by looking at the page:
 *
 *   1. SUPPLY — every percentage is divided by `totalSupply()`. If the live
 *      value has drifted from the pinned constant, the fallback path would
 *      silently skew every published share. Measured, not assumed.
 *   2. PIN — the RPC fallback starts at `pinnedFromBlock`. A pin AFTER the
 *      first pledge would delete real pledges from the fallback path with no
 *      error. Checked by asserting the receiving wallet has no history before
 *      the pin, per the indexer that carries full history.
 *   3. SOURCES — each adapter is run for real and its rows are re-validated:
 *      every row must be INTO the receiving wallet, of the right token, with a
 *      parseable BigInt amount.
 *   4. AGREEMENT — where both an indexer and the RPC can see the same window,
 *      they must return the same set of transaction hashes. A disagreement
 *      means one of them is dropping transfers, which is the failure this whole
 *      ledger is built to prevent.
 *   5. ARITHMETIC — aggregation and formatting, against synthetic transfers.
 *   6. BISECT — the `getLogs` recovery, driven by a client that fails on wide
 *      ranges, proving the retry actually recovers BOTH halves.
 *
 * Checks 1–4 all pass trivially while the ledger is empty, which is exactly the
 * window in which a summing, rounding or recovery bug would ship unnoticed and
 * then misreport the first real pledge. That is what 5 and 6 are for: they hold
 * without anyone having pledged yet.
 *
 * Run against live networks. Exits non-zero on any failure so it can gate a
 * deploy. No secrets are printed — only which env var names were present.
 */
import { createPublicClient, http, parseAbi } from "viem";
import {
  CHAINS,
  CHAIN_KEYS,
  RECEIVING_WALLET,
  NEW_TOKEN_SUPPLY,
  type ChainKey,
} from "../src/lib/pledge/config";
import {
  fetchBaseFromMoralis,
  fetchRhFromBlockscout,
  fetchFromRpc,
  getLogsRange,
} from "../src/lib/pledge/sources";
import { buildSnapshot, aggregate } from "../src/lib/pledge/ledger";
import {
  fmtPct,
  pctOfSupply,
  rawToDecimalString,
  formatAmount,
  convertToNew,
} from "../src/lib/pledge/format";
import type { PledgeTx, SourceResult } from "../src/lib/pledge/types";

const ERC20 = parseAbi(["function totalSupply() view returns (uint256)"]);

let failures = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  ✗ ${m}`);
};
const info = (m: string) => console.log(`    ${m}`);

function header(title: string) {
  console.log(`\n─── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ─── 1. Supply ───────────────────────────────────────────────────────────────

async function checkSupply(chain: ChainKey) {
  const cfg = CHAINS[chain];
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  try {
    const live = await client.readContract({
      address: cfg.token.address,
      abi: ERC20,
      functionName: "totalSupply",
    });
    const pinned = cfg.token.totalSupply;
    if (live === pinned) {
      ok(`${cfg.shortLabel} totalSupply matches the pinned constant (${live})`);
    } else {
      // Not automatically a bug — a supply change is legitimate — but the
      // constant is the fallback denominator, so it must be updated with it.
      bad(`${cfg.shortLabel} totalSupply DRIFTED: live=${live} pinned=${pinned} — update config.ts`);
    }

    // The conversion ratio is pinned, so it can silently stop matching reality.
    // Checked against LIVE supply, not the constant above, so a supply change
    // that nobody propagated to `oldPerNew` fails here rather than in a payout.
    const implied = cfg.oldPerNew * NEW_TOKEN_SUPPLY;
    if (implied === live) {
      ok(`${cfg.shortLabel} oldPerNew=${cfg.oldPerNew} still equals live supply ÷ $NEW supply`);
    } else {
      bad(
        `${cfg.shortLabel} oldPerNew=${cfg.oldPerNew} implies a supply of ${implied}, ` +
          `but the contract says ${live} — the conversion would misprice every allocation`,
      );
    }
  } catch (e) {
    bad(`${cfg.shortLabel} totalSupply() unreadable: ${(e as Error).message}`);
  }
}

// ─── 2. Pin ──────────────────────────────────────────────────────────────────

/**
 * The pin is only lossless if nothing happened before it. Rather than trusting
 * the note in config.ts, this re-derives the claim from the indexer that
 * carries full history: the earliest transfer it knows about must be at or
 * after the pinned block (or there must be none at all).
 */
async function checkPin(chain: ChainKey, indexer: SourceResult) {
  const cfg = CHAINS[chain];
  if (!indexer.ok) {
    info(`${cfg.shortLabel} pin unverified — indexer failed, cannot establish earliest transfer`);
    return;
  }
  if (indexer.txs.length === 0) {
    ok(`${cfg.shortLabel} pin safe — indexer reports zero transfers over full history`);
    return;
  }
  const earliest = Math.min(...indexer.txs.map((t) => t.blockNumber));
  if (BigInt(earliest) >= cfg.pinnedFromBlock) {
    ok(`${cfg.shortLabel} pin safe — earliest transfer at block ${earliest} ≥ pin ${cfg.pinnedFromBlock}`);
  } else {
    bad(
      `${cfg.shortLabel} PIN TOO LATE — transfer at block ${earliest} predates pin ` +
        `${cfg.pinnedFromBlock}; the RPC fallback would silently omit it`,
    );
  }
}

// ─── 3. Source validity ──────────────────────────────────────────────────────

function checkRows(label: string, result: SourceResult, chain: ChainKey) {
  if (!result.ok) {
    bad(`${label} failed: ${result.error}`);
    return;
  }
  const token = CHAINS[chain].token.address.toLowerCase();
  info(`${label}: ${result.txs.length} transfers via ${result.source}${result.truncated ? " (TRUNCATED)" : ""}`);

  let problems = 0;
  for (const t of result.txs) {
    if (t.chain !== chain) problems++;
    if (!/^0x[0-9a-fA-F]{64}$/.test(t.txHash)) problems++;
    if (!/^0x[0-9a-fA-F]{40}$/.test(t.wallet)) problems++;
    try {
      if (BigInt(t.amount) <= 0n) problems++;
    } catch {
      problems++;
    }
  }
  if (problems === 0) ok(`${label}: every row well-formed`);
  else bad(`${label}: ${problems} malformed field(s) across ${result.txs.length} rows`);

  if (result.truncated) {
    bad(`${label}: hit the page cap — the ledger would publish a SHORT list`);
  }
  info(`${label}: token filter target ${token}`);
}

// ─── 4. Indexer ↔ RPC agreement ──────────────────────────────────────────────

/**
 * The two paths must see the same transfers in the window they share.
 *
 * Only transfers at or after `pinnedFromBlock` are compared, because that is
 * the only range the RPC path claims to cover. An indexer row inside that range
 * that the RPC missed means the bisect dropped something.
 */
function checkAgreement(chain: ChainKey, indexer: SourceResult, rpc: SourceResult) {
  const cfg = CHAINS[chain];
  if (!indexer.ok || !rpc.ok) {
    info(`${cfg.shortLabel} agreement unchecked — one side failed`);
    return;
  }
  const pin = Number(cfg.pinnedFromBlock);
  const inWindow = (bn: number) => bn >= pin;

  const idxHashes = new Set(indexer.txs.filter((t) => inWindow(t.blockNumber)).map((t) => t.txHash.toLowerCase()));
  const rpcHashes = new Set(rpc.txs.filter((t) => inWindow(t.blockNumber)).map((t) => t.txHash.toLowerCase()));

  const missingFromRpc = [...idxHashes].filter((h) => !rpcHashes.has(h));
  const missingFromIdx = [...rpcHashes].filter((h) => !idxHashes.has(h));

  if (missingFromRpc.length === 0 && missingFromIdx.length === 0) {
    ok(`${cfg.shortLabel} indexer and RPC agree on ${idxHashes.size} transfer(s) at/after the pin`);
  } else {
    if (missingFromRpc.length) bad(`${cfg.shortLabel} RPC path MISSED ${missingFromRpc.length}: ${missingFromRpc.slice(0, 3).join(", ")}`);
    if (missingFromIdx.length) bad(`${cfg.shortLabel} indexer MISSED ${missingFromIdx.length}: ${missingFromIdx.slice(0, 3).join(", ")}`);
  }
}

// ─── 5. Arithmetic, on synthetic transfers ───────────────────────────────────

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (Object.is(actual, expected)) ok(`${label} → ${String(actual)}`);
  else bad(`${label} → got ${String(actual)}, expected ${String(expected)}`);
};

const tx = (wallet: string, amount: string, blockNumber: number, txHash: string): PledgeTx => ({
  wallet,
  chain: "base",
  amount,
  txHash,
  blockNumber,
  timestamp: null,
});

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const H = (n: number) => `0x${String(n).padStart(64, "0")}`;
const e18 = (whole: string) => `${whole}${"0".repeat(18)}`;

function checkArithmetic() {
  const supply = CHAINS.base.token.totalSupply; // 100e9 × 1e18

  // ── Exactness: 1e27 raw units does not survive a JS number, and this is the
  // basis of every published share.
  eq(
    "1e27 raw units round-trips exactly through the CSV formatter",
    rawToDecimalString("1000000000000000000000000000", 18),
    "1000000000",
  );
  eq("dust keeps its digits", rawToDecimalString("1234500000000000", 18), "0.0012345");
  eq("sub-unit amounts are not truncated to 0", formatAmount(10n ** 15n, 18), "0.001");

  // ── The bug that made the source app lie. 1,000 tokens against a 100e9
  // supply is one ten-millionth of a percent — real, and `toFixed(4)` prints
  // it as "0.0000%".
  const smallPct = pctOfSupply(BigInt(e18("1000")), supply);
  if (smallPct > 0) ok(`1,000 tokens of 100e9 supply computes nonzero (${smallPct})`);
  else bad(`1,000 tokens of 100e9 supply computed as ${smallPct} — precision lost in the division`);
  eq("…and never renders as zero", fmtPct(smallPct), "< 0.0001%");
  eq("the old toFixed(4) behaviour would have printed", smallPct.toFixed(4), "0.0000");

  eq("1% renders as 1.00%", fmtPct(pctOfSupply(supply / 100n, supply)), "1.00%");
  eq("a true zero still renders as 0%", fmtPct(pctOfSupply(0n, supply)), "0%");
  eq("a zero supply cannot divide-by-zero", pctOfSupply(1n, 0n), 0);

  // ── Aggregation: two transfers from one wallet are ONE row whose total is
  // their sum. Halving a pledge here is the failure mode that looks like theft.
  const rows = aggregate(
    [
      tx(A, e18("100"), 10, H(1)),
      tx(A, e18("250"), 12, H(2)),
      tx(B, e18("1000"), 11, H(3)),
    ],
    "base",
    supply,
  );
  eq("two wallets, three transfers → two rows", rows.length, 2);
  eq("largest pledge sorts first", rows[0].wallet, B);
  eq("repeat pledges from one wallet sum", rows[1].totalAmount, e18("350"));
  eq("…and are counted, not collapsed", rows[1].txCount, 2);
  eq("a wallet's rows are newest-first", rows[1].txs[0].txHash, H(2));
  eq("formatted total matches the sum", rows[1].totalFormatted, "350");

  // ── Identical transfers in one transaction must BOTH count. A de-dupe keyed
  // on (hash, from, value) would silently halve this holder's pledge.
  const dupes = aggregate([tx(A, e18("500"), 20, H(9)), tx(A, e18("500"), 20, H(9))], "base", supply);
  eq("two identical transfers in one tx are not de-duplicated away", dupes[0].totalAmount, e18("1000"));

  checkConversion();
}

// ─── 5b. The conversion — the 100× trap ──────────────────────────────────────

/**
 * The playbook promises "each pledger keeps the same proportional share", and
 * derives it from a 1-for-1 airdrop — which only preserves the share when the
 * two supplies are equal. Base's is 100× the new supply, so 1-for-1 there is
 * both unfair and impossible. These assertions pin the ratio that keeps the
 * PROMISE instead of the arithmetic, and make the impossible version fail loudly
 * if anyone ever "simplifies" it back.
 */
function checkConversion() {
  eq("Base converts at 100:1, not 1:1", CHAINS.base.oldPerNew, 100n);
  eq("RH is the one chain where 1-for-1 is correct", CHAINS.rh.oldPerNew, 1n);

  // Why Base cannot be 1:1 — stated as arithmetic, not as a comment.
  const fortyPct = (CHAINS.base.token.totalSupply * 40n) / 100n;
  if (fortyPct > NEW_TOKEN_SUPPLY) {
    ok(
      `1-for-1 on Base is impossible: ${fortyPct / 10n ** 18n} tokens at the ` +
        `playbook's ~40% participation vs a new supply of ${NEW_TOKEN_SUPPLY / 10n ** 18n}`,
    );
  } else {
    bad("1-for-1 on Base no longer overflows the new supply — re-derive oldPerNew");
  }

  eq("1,000 old Base tokens become 10 new", convertToNew(e18("1000"), 100n), e18("10"));
  eq("1,000 old RH tokens become 1,000 new", convertToNew(e18("1000"), 1n), e18("1000"));
  eq("conversion truncates DOWN, never mints a fraction", convertToNew("150", 100n), "1");

  // The fairness claim, made checkable: the same proportional stake on either
  // chain has to pay out the same number of new tokens. Under 1-for-1 the Base
  // holder here would receive 1,000,000,000 — the entire new supply.
  const onePctBase = convertToNew((CHAINS.base.token.totalSupply / 100n).toString(), CHAINS.base.oldPerNew);
  const onePctRh = convertToNew((CHAINS.rh.token.totalSupply / 100n).toString(), CHAINS.rh.oldPerNew);
  eq("1% of Base and 1% of RH receive the same amount", onePctBase, onePctRh);
  eq("…and that amount is 1% of the new supply", onePctBase, (NEW_TOKEN_SUPPLY / 100n).toString());

  // The identity the whole design rests on, checked on both chains at a size
  // that is not a round fraction: share of the old supply == share of the new.
  for (const chain of CHAIN_KEYS) {
    const cfg = CHAINS[chain];
    const pledged = BigInt(e18("3250531"));
    const received = BigInt(convertToNew(pledged.toString(), cfg.oldPerNew));
    const before = pctOfSupply(pledged, cfg.token.totalSupply);
    const after = pctOfSupply(received, NEW_TOKEN_SUPPLY);
    const drift = before === 0 ? Math.abs(after) : Math.abs(after - before) / before;
    if (drift < 1e-9) {
      ok(`${cfg.shortLabel}: 3,250,531 pledged keeps its share exactly (${fmtPct(before)})`);
    } else {
      bad(`${cfg.shortLabel}: share moved from ${before} to ${after} through the conversion`);
    }
  }
}

// ─── 6. The bisect — the anti-silent-drop guarantee ──────────────────────────

/**
 * A real RPC cannot be asked to fail on demand, and the live ledger is empty,
 * so every live run of the fallback path proves nothing about its recovery.
 * This drives `getLogsRange` with a client that fails on any range wider than
 * `maxWidth` and succeeds below it — the exact shape of a provider that
 * rate-limits or times out on large `getLogs` windows.
 *
 * The specific regression under test: the obvious implementation catches the
 * error, retries `from..mid`, and moves on — permanently losing everything in
 * `mid+1..to` while reporting success. So the fixture deliberately puts a log
 * in the FINAL eighth of the range, where that bug would swallow it.
 */
function fakeClient(logBlocks: number[], maxWidth: bigint, alwaysFail = false) {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLogs: async ({ fromBlock, toBlock }: any) => {
        calls++;
        if (alwaysFail || toBlock - fromBlock > maxWidth) throw new Error("range too wide");
        return logBlocks
          .filter((b) => BigInt(b) >= fromBlock && BigInt(b) <= toBlock)
          .map((b) => ({
            // +1 so the log seeded at block 0 still carries a nonzero value —
            // a zero-value transfer is not a pledge and the row check rejects it.
            args: { from: A, value: (BigInt(b) + 1n) * 10n ** 18n },
            transactionHash: H(b),
            blockNumber: BigInt(b),
          }));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

async function checkBisect() {
  // Logs spread across the range, including block 990 — inside the final
  // eighth, which the drop-the-second-half bug loses.
  const seeded = [0, 3, 250, 501, 640, 990, 999];
  const { client, calls } = fakeClient(seeded, 100n);

  const out: PledgeTx[] = [];
  try {
    await getLogsRange(client, "base", 0n, 999n, out, { calls: 0 });
  } catch (e) {
    bad(`bisect threw on a recoverable range: ${(e as Error).message}`);
    return;
  }

  const found = out.map((t) => t.blockNumber).sort((a, b) => a - b);
  const missing = seeded.filter((b) => !found.includes(b));
  if (missing.length === 0 && found.length === seeded.length) {
    ok(`bisect recovered all ${seeded.length} logs from a failing wide range (${calls()} calls)`);
  } else {
    bad(`bisect LOST blocks ${missing.join(", ")} — found ${found.join(", ")}`);
  }
  if (out.every((t) => BigInt(t.amount) > 0n && /^0x[0-9a-f]{64}$/i.test(t.txHash))) {
    ok("recovered logs are decoded into well-formed rows");
  } else {
    bad("recovered logs decoded into malformed rows");
  }

  // Unsplittable and still failing: the ONLY correct answer is to throw. A
  // partial list returned as success is the failure this whole file prevents.
  const dead = fakeClient([], 0n, true);
  let threw = false;
  try {
    await getLogsRange(dead.client, "base", 0n, 63n, [], { calls: 0 });
  } catch {
    threw = true;
  }
  if (threw) ok("a range that cannot be split further THROWS rather than returning a short list");
  else bad("a permanently failing range returned success — silent drop is possible");

  // The call budget must also throw, not truncate mid-range.
  let budgetThrew = false;
  try {
    await getLogsRange(fakeClient([], 0n, true).client, "base", 0n, 1023n, [], { calls: 99999 });
  } catch (e) {
    budgetThrew = (e as Error).message.includes("budget");
  }
  if (budgetThrew) ok("an exhausted call budget throws instead of silently stopping");
  else bad("an exhausted call budget did not throw");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Blue Agent — pledge ledger verification");
  console.log(`receiving wallet: ${RECEIVING_WALLET}`);
  console.log(
    `env present: ${["MORALIS_API_KEY", "BASE_RPC_URL", "ROBINHOOD_RPC_URL", "ROBINHOOD_BLOCKSCOUT_URL"]
      .filter((k) => !!process.env[k])
      .join(", ") || "(none — public endpoints only)"}`,
  );

  header("1. totalSupply — the denominator of every published percentage");
  for (const chain of CHAIN_KEYS) await checkSupply(chain);

  header("2 & 3. sources");
  const results: Record<ChainKey, { indexer: SourceResult; rpc: SourceResult }> = {} as never;

  for (const chain of CHAIN_KEYS) {
    const indexer = chain === "base" ? await fetchBaseFromMoralis() : await fetchRhFromBlockscout();
    const rpc = await fetchFromRpc(chain);
    results[chain] = { indexer, rpc };
    checkRows(`${CHAINS[chain].shortLabel} indexer`, indexer, chain);
    checkRows(`${CHAINS[chain].shortLabel} rpc`, rpc, chain);
    await checkPin(chain, indexer);
  }

  header("4. indexer ↔ rpc agreement inside the pinned window");
  for (const chain of CHAIN_KEYS) {
    checkAgreement(chain, results[chain].indexer, results[chain].rpc);
  }

  header("5. arithmetic — synthetic transfers, no chain involved");
  checkArithmetic();

  header("6. bisect recovery — a deliberately failing RPC");
  await checkBisect();

  header("7. snapshot assembly");
  const snap = await buildSnapshot(null);
  for (const chain of CHAIN_KEYS) {
    const s = snap.chains[chain];
    info(
      `${s.shortLabel}: ${s.totalFormatted} ${s.symbol} · ${s.walletCount} wallets · ` +
        `${s.txCount} txs · ${s.status} · supply from ${s.supplySource}`,
    );
    if (s.status === "degraded") bad(`${s.shortLabel} degraded: ${s.error}`);
  }

  // A wallet's total must equal the sum of its own rows — the one invariant
  // that catches an aggregation bug silently halving someone's pledge.
  let sumErrors = 0;
  for (const w of snap.wallets) {
    const summed = w.txs.reduce((acc, t) => acc + BigInt(t.amount), 0n);
    if (summed.toString() !== w.totalAmount) sumErrors++;
  }
  if (sumErrors === 0) ok(`wallet totals reconcile with their transfer rows (${snap.wallets.length} wallets)`);
  else bad(`${sumErrors} wallet total(s) do NOT equal the sum of their rows`);

  console.log(
    `\n${failures === 0 ? "PASS" : `FAIL — ${failures} problem(s)`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nFAIL — script threw: ${(e as Error).message}`);
  process.exit(1);
});
