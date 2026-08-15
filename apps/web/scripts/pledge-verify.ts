/**
 * Reconcile the PUBLISHED pledge ledger against the CHAIN.
 *
 * Read-only. Writes nothing, proposes nothing, and exits non-zero when the two
 * disagree — a check that always exits 0 is not a check.
 *
 * ─── Why ground truth is getLogs and not either indexer ─────────────────────
 * `sources.ts` reads Base through Moralis and RH through Blockscout, falling
 * back to RPC only when an indexer fails. "The indexer silently returned a
 * short list" is therefore not a failure the ledger can detect about itself:
 * a truncated page and a genuinely empty range look identical downstream, and
 * the snapshot would be published as `status: "ok"`. So this script does not
 * ask the indexers anything. It walks Transfer logs straight off the chain and
 * diffs them against what blueagent.dev actually serves.
 *
 * ─── The four invariants ────────────────────────────────────────────────────
 *   0. BALANCE    `balanceOf(receiving)` == published sum. One `eth_call`, no
 *                 block range, no indexer — so it is the ONLY check here that
 *                 does not inherit `pinnedFromBlock`'s blind spot (RH's pin
 *                 carries ~1 day of margin by design; 1–3 below cannot see a
 *                 transfer older than it, and would report a clean PASS while
 *                 the ledger was short). Runs first and runs even when the log
 *                 scan fails.
 *   1. COMPLETE   every on-chain transfer into the receiving wallet appears in
 *                 the published ledger, individually, addressable by its hash.
 *                 Not "the totals agree" — a holder verifies a receipt, and a
 *                 sum cannot be clicked.
 *   2. NO PHANTOM nothing is published that is not on chain. The inverse of 1,
 *                 and the one that would matter most if it ever fired.
 *   3. EXACT SUM  published raw units == chain raw units, in BigInt. Catches a
 *                 double-count that 1 and 2 would both pass, since a duplicated
 *                 row has a hash that does exist.
 *
 * The CSV is checked as well as the JSON because they are separate public
 * surfaces and only one of them is what an auditor downloads.
 *
 * Usage:  npm run pledge:verify
 *         PLEDGE_API=http://localhost:3000/api/pledge npm run pledge:verify
 */
import { createPublicClient, http, parseAbiItem, getAddress } from "viem";
import { CHAINS, RECEIVING_WALLET, CHAIN_KEYS, type ChainKey } from "../src/lib/pledge/config";

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const BALANCE_OF = parseAbiItem("function balanceOf(address) view returns (uint256)");

const API = process.env.PLEDGE_API ?? "https://blueagent.dev/api/pledge";

interface ApiWallet {
  wallet: string;
  chain: string;
  totalAmount: string;
  txCount: number;
  txs: { txHash: string; timestamp: number | null; amount: string }[];
}

interface ChainLog {
  txHash: string;
  from: string;
  amount: bigint;
  blockNumber: number;
  logIndex: number;
}

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ❌ ${msg}`);
};

/** What the token itself says the receiving wallet holds. One call, no range. */
async function readBalance(chain: ChainKey): Promise<bigint> {
  const cfg = CHAINS[chain];
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  return client.readContract({
    address: cfg.token.address,
    abi: [BALANCE_OF],
    functionName: "balanceOf",
    args: [RECEIVING_WALLET],
  });
}

/**
 * All Transfer logs into the receiving wallet, or throw.
 *
 * The bisect mirrors `sources.ts:getLogsRange` for the same reason it exists
 * there: retrying only the first half of a failed range would drop the second
 * half permanently and still report success, which in a VERIFIER would produce
 * a false "everything matches" — the worst possible output from this file.
 */
async function scanChain(
  chain: ChainKey,
): Promise<{ logs: ChainLog[]; head: bigint; calls: number }> {
  const cfg = CHAINS[chain];
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  const head = await client.getBlockNumber();
  const out: ChainLog[] = [];
  let calls = 0;

  async function range(from: bigint, to: bigint): Promise<void> {
    calls++;
    try {
      const logs = await client.getLogs({
        address: cfg.token.address,
        event: TRANSFER,
        args: { to: RECEIVING_WALLET },
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) {
        out.push({
          txHash: l.transactionHash,
          from: getAddress(l.args.from as string),
          amount: l.args.value as bigint,
          blockNumber: Number(l.blockNumber),
          logIndex: l.logIndex ?? 0,
        });
      }
    } catch (e) {
      if (to <= from) throw e;
      const mid = from + (to - from) / 2n;
      await range(from, mid);
      await range(mid + 1n, to);
    }
  }

  // RH mines ~10 blocks/s, so a Base-sized window would cost hundreds of calls.
  const CHUNK = chain === "rh" ? 40_000n : 9_500n;
  let from = cfg.pinnedFromBlock;
  while (from <= head) {
    const to = from + CHUNK > head ? head : from + CHUNK;
    await range(from, to);
    from = to + 1n;
  }
  return { logs: out, head, calls };
}

async function main() {
  console.log("=".repeat(78));
  console.log("PLEDGE LEDGER VERIFY — published vs chain");
  console.log("=".repeat(78));
  console.log(`api            ${API}`);
  console.log(`receiving      ${RECEIVING_WALLET}`);

  const api = (await (await fetch(API, { cache: "no-store" })).json()) as {
    updatedAt: number;
    stale: boolean;
    degraded: boolean;
    chains: Record<string, { txCount: number; source: string; status: string; truncated?: boolean }>;
    wallets: ApiWallet[];
  };
  const csv = await (await fetch(`${API}?format=csv`, { cache: "no-store" })).text();
  const csvRows = csv
    .split("\n")
    .slice(1)
    .filter((l) => l.trim().length > 0);

  console.log(`snapshot       ${new Date(api.updatedAt).toISOString()}`);
  console.log(`stale=${api.stale}  degraded=${api.degraded}`);

  // A degraded snapshot is serving last-known numbers by design, so a diff
  // against it measures the outage, not the ledger. Say so instead of
  // reporting misleading mismatches as bugs.
  if (api.degraded) {
    console.log(
      "\n  ⚠️  snapshot is DEGRADED — at least one chain read failed and the numbers\n" +
        "      below are the last known good ones. Differences here are expected and\n" +
        "      are not evidence of a ledger bug. Re-run once it recovers.",
    );
  }
  console.log();

  for (const chain of CHAIN_KEYS) {
    const cfg = CHAINS[chain];
    const c = api.chains[chain];
    console.log("-".repeat(78));
    console.log(`${cfg.label}   token ${cfg.token.address}`);
    console.log(
      `  published  txCount=${c.txCount}  source=${c.source}  status=${c.status}  truncated=${c.truncated ?? false}`,
    );

    if (c.truncated) {
      fail(
        `${cfg.label}: ledger reports TRUNCATED — it hit a page cap and is knowingly short.`,
      );
    }

    // Built before any log scan, because invariant 0 has to run even when the
    // scan fails — a failed scan is exactly when you most want a second opinion.
    const pub = new Map<string, bigint>();
    for (const w of api.wallets) {
      if (w.chain !== chain) continue;
      for (const t of w.txs) {
        const k = t.txHash.toLowerCase();
        pub.set(k, (pub.get(k) ?? 0n) + BigInt(t.amount));
      }
    }
    const pubSum = [...pub.values()].reduce((a, b) => a + b, 0n);

    // 0 — BALANCE. The token's own accounting, which no page cap, pinned block
    // or indexer bug can shorten.
    let balanceOk = false;
    try {
      const bal = await readBalance(chain);
      balanceOk = bal === pubSum;
      if (balanceOk) {
        console.log(`  balanceOf  ${bal} — equals published sum to the raw unit`);
      } else {
        fail(
          `${cfg.label}: balanceOf ${bal} != published ${pubSum} (delta ${bal - pubSum}).\n` +
            `       A POSITIVE delta means transfers landed that the ledger did not publish.\n` +
            `       It also goes positive-or-negative if the receiving wallet has ever sent\n` +
            `       tokens OUT — if that is now true, this check needs an outbound term\n` +
            `       before it can be trusted either way. Check the wallet's transfers first.`,
        );
      }
    } catch (e) {
      fail(`${cfg.label}: balanceOf read failed (${(e as Error).message}).`);
    }

    let scan: Awaited<ReturnType<typeof scanChain>>;
    try {
      scan = await scanChain(chain);
    } catch (e) {
      fail(`${cfg.label}: chain scan failed (${(e as Error).message}) — no ground truth.`);
      console.log();
      continue;
    }
    console.log(
      `  chain      ${scan.logs.length} transfers  ` +
        `(blocks ${cfg.pinnedFromBlock}..${scan.head}, ${scan.calls} calls)`,
    );

    const onchain = new Map<string, bigint>();
    for (const l of scan.logs) {
      const k = l.txHash.toLowerCase();
      onchain.set(k, (onchain.get(k) ?? 0n) + l.amount);
    }

    // 1 — COMPLETE
    const missing = scan.logs.filter((l) => !pub.has(l.txHash.toLowerCase()));
    if (missing.length > 0) {
      fail(`${cfg.label}: ${missing.length} on-chain transfer(s) NOT published:`);
      for (const m of missing.sort((a, b) => a.blockNumber - b.blockNumber)) {
        console.log(
          `       block ${m.blockNumber}  from ${m.from}  ${cfg.explorerTx(m.txHash)}`,
        );
      }
    }

    // 2 — NO PHANTOM
    const phantom = [...pub.keys()].filter((h) => !onchain.has(h));
    if (phantom.length > 0) {
      fail(`${cfg.label}: ${phantom.length} published transfer(s) NOT on chain:`);
      for (const h of phantom) console.log(`       ${h}`);
    }

    // 3 — EXACT SUM
    const chainSum = scan.logs.reduce((a, l) => a + l.amount, 0n);
    if (pubSum !== chainSum) {
      fail(
        `${cfg.label}: raw-unit total differs — published ${pubSum}, chain ${chainSum} ` +
          `(delta ${pubSum - chainSum})`,
      );
    }

    // Counts. Distinct from the sum: a duplicated row passes 1 and 2.
    if (scan.logs.length !== c.txCount) {
      fail(
        `${cfg.label}: txCount says ${c.txCount}, chain has ${scan.logs.length} transfers.`,
      );
    }

    const csvForChain = csvRows.filter((l) =>
      l.toLowerCase().startsWith(`"${cfg.shortLabel.toLowerCase()}"`),
    );
    if (csvForChain.length !== scan.logs.length) {
      fail(
        `${cfg.label}: CSV has ${csvForChain.length} rows, chain has ${scan.logs.length}.`,
      );
    }

    if (
      balanceOk &&
      missing.length === 0 &&
      phantom.length === 0 &&
      pubSum === chainSum &&
      scan.logs.length === c.txCount &&
      csvForChain.length === scan.logs.length
    ) {
      console.log(
        `  ✅ ${scan.logs.length}/${scan.logs.length} transfers published, ` +
          `sums exact, balance exact, CSV complete`,
      );
    }
    console.log();
  }

  // Every transfer must be individually addressable, not just summed into a
  // wallet total. This is the invariant the ledger table broke on 2026-08-15:
  // 28 transfers were correctly counted but only 25 were reachable, because the
  // table rendered one row per wallet and linked only the newest hash.
  const walletRows = api.wallets.length;
  const txRows = api.wallets.reduce((n, w) => n + w.txCount, 0);
  console.log("-".repeat(78));
  console.log(`addressability   ${txRows} transfers across ${walletRows} wallets`);
  const repeats = api.wallets.filter((w) => w.txCount > 1);
  if (repeats.length > 0) {
    console.log(
      `  ${repeats.length} wallet(s) pledged more than once — each of those transfers\n` +
        `  must have its own row and its own link on /pledge:`,
    );
    for (const w of repeats) {
      console.log(`    ${w.wallet} [${w.chain}] ${w.txCount} transfers`);
    }
  } else {
    console.log("  no repeat pledgers — the per-wallet and per-transfer views coincide.");
  }

  console.log();
  console.log("=".repeat(78));
  if (failures === 0) {
    console.log("PASS — published ledger matches the chain exactly. Nothing was written.");
    console.log("=".repeat(78));
    return;
  }
  console.log(`FAIL — ${failures} problem(s) above. Nothing was written.`);
  console.log("=".repeat(78));
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("verify crashed:", e);
  process.exit(1);
});
