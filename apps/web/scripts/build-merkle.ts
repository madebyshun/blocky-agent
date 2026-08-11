/**
 * scripts/build-merkle.ts — `npm run merkle:build -- <allocations.csv>`
 *
 * Turns the final allocation table into the four artifacts launch day needs:
 * a root to publish, a tree to archive, a proof per wallet to serve, and a
 * summary a human can diff against the CSV they already published.
 *
 * ─── Why this script is written to fail rather than cope ────────────────────
 *
 * Every other part of the migration is recoverable. This one is not: the root
 * goes into an immutable contract, and a wallet whose row was silently dropped,
 * truncated or merged here has no way to claim and no way to prove they should
 * have been able to. So every ambiguity below is a hard error with the offending
 * line number attached, never a skip, a coercion, or a best guess:
 *
 *   • a row that is not exactly `wallet,chain,new_amount`      → throw
 *   • an address that fails checksum validation                 → throw
 *   • an amount of zero, negative, or unparseable               → throw
 *   • an amount with more than 18 decimal places                → throw
 *   • the same wallet twice, without --aggregate                → throw
 *
 * The 18-decimal rule is the least obvious and the most dangerous: `parseUnits`
 * silently truncates a 19th decimal place, so "1.0000000000000000009" would
 * become 1e18 wei and nobody would ever see the difference. Truncating one
 * holder's allocation without telling anyone is exactly the failure this whole
 * ledger exists to prevent, so it is refused instead.
 *
 * ─── Duplicate wallets, and why they are refused by default ─────────────────
 *
 * A holder who pledged on BOTH Base and Robinhood Chain legitimately produces
 * two rows. That is not a malformed CSV — but it IS fatal to a claim page that
 * looks holders up by address, because a plain address→allocation map keeps
 * whichever row it saw last and shows that holder a number smaller than what
 * they are owed. Refusing by default means this gets decided deliberately;
 * `--aggregate` sums the rows, records every merge in summary.txt, and the
 * per-chain breakdown stays visible so the merge can be checked against the
 * published CSV rather than trusted.
 *
 * ─── Determinism ────────────────────────────────────────────────────────────
 *
 * Rows are sorted by lowercased address before indices are assigned, so the
 * root depends on the CONTENT of the CSV and not on the order its rows happen
 * to be in. Re-exporting the same allocations from a spreadsheet with a
 * different sort therefore cannot change the root — a property
 * `scripts/merkle-build-test.ts` asserts by shuffling a fixture and comparing.
 *
 * ─── Where the outputs go ───────────────────────────────────────────────────
 *
 *   claim-data/tree.json      full OZ tree dump — the archival artifact, the
 *                             thing from which any proof can be regenerated
 *   claim-data/root.txt       the root, one line, for publishing
 *   claim-data/summary.txt    human-checkable totals + top 10
 *   apps/web/public/claim-data/proofs.json
 *                             the ONLY artifact the browser needs, so it is the
 *                             only one that lives under public/. proofs.json
 *                             carries the root inside it, and the claim page
 *                             refuses to render a claim button unless that root
 *                             matches the one it reads from the contract — so a
 *                             stale published file cannot hand anyone a proof
 *                             for a tree the contract is not paying against.
 */
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, parseUnits, isAddress } from "viem";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** 18 decimals — matches NEW_TOKEN_DECIMALS in src/lib/pledge/config.ts. */
const DECIMALS = 18;

/** Leaf field types. MUST stay in sync with MerkleDistributor.claim(). */
const LEAF_ENCODING = ["uint256", "address", "uint256"] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const CLAIM_DATA_DIR = resolve(REPO_ROOT, "claim-data");
const PUBLIC_DIR = resolve(REPO_ROOT, "apps/web/public/claim-data");

export interface AllocationRow {
  address: `0x${string}`;
  chains: string[];
  amountWei: bigint;
  /** Source line numbers, for the audit trail when rows were aggregated. */
  lines: number[];
}

export interface BuildResult {
  root: `0x${string}`;
  rows: AllocationRow[];
  totalWei: bigint;
  tree: StandardMerkleTree<[string, string, string]>;
  /**
   * Typed as `0x${string}[]` — the same shape `ProofsFile` in
   * `src/lib/claim/config.ts` declares — so that the builder and the page agree
   * at the type level and neither side has to re-cast what the other emits.
   */
  proofs: Record<string, { index: number; amount: string; proof: `0x${string}`[] }>;
  csvSha256: string;
  aggregated: { address: string; lines: number[]; chains: string[] }[];
}

class CsvError extends Error {
  constructor(line: number, msg: string) {
    super(`line ${line}: ${msg}`);
    this.name = "CsvError";
  }
}

/**
 * Whole-token decimal string → wei, refusing anything `parseUnits` would round.
 *
 * Deliberately does its own shape check first: parseUnits accepts "1e3",
 * "1,000" and "1.00000000000000000099" without complaint (coercing, grouping
 * and truncating respectively), and each of those would put a number in the
 * tree that differs from the number in the published CSV.
 */
export function parseAmount(raw: string, line: number): bigint {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new CsvError(line, `amount "${raw}" is not a plain decimal number (no signs, commas, or exponents)`);
  }
  const frac = s.includes(".") ? s.split(".")[1] : "";
  if (frac.length > DECIMALS) {
    throw new CsvError(line, `amount "${raw}" has ${frac.length} decimal places; the token has ${DECIMALS}`);
  }
  const wei = parseUnits(s, DECIMALS);
  if (wei <= 0n) {
    throw new CsvError(line, `amount "${raw}" is zero — a zero allocation is a leaf nobody can use, drop the row instead`);
  }
  return wei;
}

/**
 * Address → checksummed form, rejecting a bad checksum rather than repairing it.
 *
 * An all-lowercase or all-uppercase address carries no checksum, so it is
 * accepted and normalised. A MIXED-case address does carry one, and if it fails
 * the address was mistyped or mangled in transit — silently re-checksumming it
 * would turn a typo into a permanent allocation for a wallet nobody controls.
 */
export function parseAddress(raw: string, line: number): `0x${string}` {
  const s = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    throw new CsvError(line, `"${raw}" is not a 20-byte hex address`);
  }
  const hasUpper = /[A-F]/.test(s.slice(2));
  const hasLower = /[a-f]/.test(s.slice(2));
  if (hasUpper && hasLower && !isAddress(s, { strict: true })) {
    throw new CsvError(line, `"${raw}" is mixed-case but fails EIP-55 checksum — likely a typo`);
  }
  return getAddress(s.toLowerCase());
}

export function parseCsv(text: string, opts: { aggregate: boolean }): {
  rows: AllocationRow[];
  aggregated: { address: string; lines: number[]; chains: string[] }[];
} {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) throw new Error("empty CSV");

  // Header is required. A headerless file whose first row happens to parse
  // would silently drop that first allocation.
  const headerIdx = lines.findIndex((l) => l.trim() !== "");
  if (headerIdx === -1) throw new Error("CSV contains no rows");
  const header = lines[headerIdx].split(",").map((h) => h.trim().toLowerCase());
  const expected = ["wallet", "chain", "new_amount"];
  if (header.length !== 3 || !expected.every((h, i) => header[i] === h)) {
    throw new CsvError(headerIdx + 1, `header must be exactly "${expected.join(",")}", got "${lines[headerIdx].trim()}"`);
  }

  const byAddress = new Map<string, AllocationRow>();

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (raw.trim() === "") continue; // blank lines are fine; blank FIELDS are not

    const cells = raw.split(",");
    if (cells.length !== 3) {
      throw new CsvError(lineNo, `expected 3 fields (wallet,chain,new_amount), got ${cells.length}: "${raw.trim()}"`);
    }

    const address = parseAddress(cells[0], lineNo);
    const chain = cells[1].trim();
    if (chain === "") throw new CsvError(lineNo, "chain is empty");
    const amountWei = parseAmount(cells[2], lineNo);

    const key = address.toLowerCase();
    const existing = byAddress.get(key);
    if (existing) {
      if (!opts.aggregate) {
        throw new CsvError(
          lineNo,
          `wallet ${address} already appears on line ${existing.lines[0]} (chains: ${existing.chains.join(", ")}). ` +
            `The claim page looks holders up by address and would only ever show ONE of these rows. ` +
            `Re-run with --aggregate to sum them into a single allocation, or fix the CSV.`,
        );
      }
      existing.amountWei += amountWei;
      existing.chains.push(chain);
      existing.lines.push(lineNo);
    } else {
      byAddress.set(key, { address, chains: [chain], amountWei, lines: [lineNo] });
    }
  }

  if (byAddress.size === 0) throw new Error("CSV has a header but no allocation rows");

  // Sorted by lowercased address so index assignment — and therefore the root —
  // depends on content, not on the CSV's row order.
  const rows = [...byAddress.values()].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
  const aggregated = rows
    .filter((r) => r.lines.length > 1)
    .map((r) => ({ address: r.address, lines: r.lines, chains: r.chains }));

  return { rows, aggregated };
}

export function build(csvText: string, opts: { aggregate: boolean }): BuildResult {
  const { rows, aggregated } = parseCsv(csvText, opts);

  const values: [string, string, string][] = rows.map((r, i) => [
    String(i),
    r.address,
    r.amountWei.toString(),
  ]);

  // StandardMerkleTree, never a hand-rolled tree: it fixes the leaf encoding
  // (double-keccak over abi.encode) and the sorted-pair node hashing that
  // OZ's on-chain MerkleProof.verify expects. Getting either wrong produces a
  // tree that looks perfectly valid and verifies nowhere.
  const tree = StandardMerkleTree.of(values, [...LEAF_ENCODING]);

  const proofs: BuildResult["proofs"] = {};
  for (const [treeIdx, value] of tree.entries()) {
    const [indexStr, address, amount] = value;
    proofs[address.toLowerCase()] = {
      index: Number(indexStr),
      amount,
      // getProof is typed `string[]`; every element is a 0x-prefixed 32-byte
      // hex string. Narrowed once, here, rather than at each consumer.
      proof: tree.getProof(treeIdx) as `0x${string}`[],
    };
  }

  return {
    root: tree.root as `0x${string}`,
    rows,
    totalWei: rows.reduce((a, r) => a + r.amountWei, 0n),
    tree,
    proofs,
    csvSha256: createHash("sha256").update(csvText).digest("hex"),
    aggregated,
  };
}

function fmtTokens(wei: bigint): string {
  const whole = wei / 10n ** BigInt(DECIMALS);
  const frac = (wei % 10n ** BigInt(DECIMALS)).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

function renderSummary(r: BuildResult, csvPath: string, aggregate: boolean): string {
  const top = [...r.rows].sort((a, b) => (b.amountWei > a.amountWei ? 1 : -1)).slice(0, 10);
  const perChain = new Map<string, { wallets: number; wei: bigint }>();
  for (const row of r.rows) {
    for (const c of new Set(row.chains)) {
      const e = perChain.get(c) ?? { wallets: 0, wei: 0n };
      e.wallets += 1;
      // A row aggregated across chains cannot be split back apart, so the wei
      // column is attributed once, to the row's first chain, and this is said
      // out loud below rather than left for someone to discover by summing.
      if (row.chains[0] === c) e.wei += row.amountWei;
      perChain.set(c, e);
    }
  }

  const L: string[] = [];
  L.push("$NEW allocation — merkle summary");
  L.push("=".repeat(60));
  L.push("");
  L.push(`generated      ${new Date().toISOString()}`);
  L.push(`source csv     ${csvPath}`);
  L.push(`csv sha256     ${r.csvSha256}`);
  L.push(`aggregate mode ${aggregate ? "ON — duplicate wallets summed" : "off — duplicates would have failed the build"}`);
  L.push("");
  L.push(`MERKLE ROOT    ${r.root}`);
  L.push("");
  L.push("-".repeat(60));
  L.push(`total wallets  ${r.rows.length.toLocaleString("en-US")}`);
  L.push(`total $NEW     ${fmtTokens(r.totalWei)}`);
  L.push(`total wei      ${r.totalWei.toString()}   <- fund the contract with EXACTLY this`);
  L.push("-".repeat(60));
  L.push("");
  L.push("per chain (wallet counts overlap if a holder pledged on both):");
  for (const [chain, e] of [...perChain.entries()].sort()) {
    L.push(`  ${chain.padEnd(12)} ${String(e.wallets).padStart(7)} wallets   ${fmtTokens(e.wei)} $NEW`);
  }
  if (r.aggregated.length > 0) {
    L.push("");
    L.push(`NOTE: ${r.aggregated.length} wallet(s) appeared on more than one line and were SUMMED.`);
    L.push("      Their $NEW is attributed to the first chain listed, so the per-chain");
    L.push("      wei column above does not split them. Full list:");
    for (const a of r.aggregated) {
      L.push(`  ${a.address}  lines ${a.lines.join("+")}  chains ${a.chains.join("+")}`);
    }
  }
  L.push("");
  // 28 wide: a full-precision 18-decimal amount ("999999.999999999999999999")
  // is 25 characters, and letting it overflow the column would shunt the share
  // figures out of alignment on exactly the rows most worth eyeballing.
  L.push("top 10 allocations:");
  L.push("  " + "#".padStart(3) + "  " + "wallet".padEnd(42) + "  " + "$NEW".padStart(28) + "  share");
  top.forEach((row, i) => {
    const share = (Number((row.amountWei * 1_000_000n) / r.totalWei) / 1_000_000) * 100;
    L.push(
      "  " +
        String(i + 1).padStart(3) +
        "  " +
        row.address.padEnd(42) +
        "  " +
        fmtTokens(row.amountWei).padStart(28) +
        `  ${share.toFixed(4)}%`,
    );
  });
  L.push("");
  L.push("CHECK BEFORE DEPLOY: total wallets and total $NEW above must match the");
  L.push("allocation CSV you published. If they do not, STOP — do not deploy this root.");
  L.push("");
  return L.join("\n");
}

export function writeArtifacts(r: BuildResult, csvPath: string, aggregate: boolean): void {
  mkdirSync(CLAIM_DATA_DIR, { recursive: true });
  mkdirSync(PUBLIC_DIR, { recursive: true });

  writeFileSync(resolve(CLAIM_DATA_DIR, "tree.json"), JSON.stringify(r.tree.dump(), null, 2) + "\n");
  writeFileSync(resolve(CLAIM_DATA_DIR, "root.txt"), r.root + "\n");
  writeFileSync(resolve(CLAIM_DATA_DIR, "summary.txt"), renderSummary(r, csvPath, aggregate));

  const envelope = {
    // The claim page compares this against merkleRoot() read from the contract
    // and refuses to show a claim button on mismatch. That check is why this
    // file being stale is a visible error rather than a silent wrong proof.
    merkleRoot: r.root,
    leafEncoding: LEAF_ENCODING,
    tokenDecimals: DECIMALS,
    walletCount: r.rows.length,
    totalWei: r.totalWei.toString(),
    csvSha256: r.csvSha256,
    generatedAt: new Date().toISOString(),
    proofs: r.proofs,
  };
  writeFileSync(resolve(PUBLIC_DIR, "proofs.json"), JSON.stringify(envelope) + "\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const aggregate = argv.includes("--aggregate");
  const csvArg = argv.find((a) => !a.startsWith("--"));
  if (!csvArg) {
    console.error("usage: npm run merkle:build -- <allocations.csv> [--aggregate]");
    process.exit(1);
  }
  const csvPath = resolve(process.cwd(), csvArg);
  const csvText = readFileSync(csvPath, "utf8");

  const r = build(csvText, { aggregate });
  writeArtifacts(r, csvPath, aggregate);

  console.log(renderSummary(r, csvPath, aggregate));
  console.log(`wrote ${CLAIM_DATA_DIR}/{tree.json,root.txt,summary.txt}`);
  console.log(`wrote ${PUBLIC_DIR}/proofs.json`);
}

// Only run when invoked directly, so the test can import build()/parseCsv().
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`\n✗ BUILD FAILED — no artifacts written\n  ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
