/**
 * scripts/claim-page-test.ts — `npm run test:claim`
 *
 * The claim page has two pure surfaces that decide what a holder sees, and both
 * fail silently if they are wrong:
 *
 *   1. THE BROWSER-SIDE VERIFIER. `lib/claim/merkle.ts` re-checks a holder's
 *      proof before the page offers a Claim button. It is a second, independent
 *      implementation of the same encoding the Solidity uses — which means it
 *      can disagree with the tree builder, and if it does, the page either hides
 *      a valid claim behind a scary error or waves through a proof that will
 *      revert. So every proof the REAL builder emits is run through it here,
 *      including the tampered case that must be rejected.
 *
 *   2. THE FORMATTER. `formatNew` renders the number a holder reads as "what I
 *      am owed". The specific failure it exists to prevent: the pledge page's
 *      `formatAmount` caps at 6 decimal places, which renders a 1-wei
 *      allocation as "0" — on the page whose entire job is paying it out. The
 *      fixture CSV contains a 1-wei allocation precisely so this is testable.
 *
 * Plus the revert-message mapping, because "AlreadyClaimed" and "InvalidProof"
 * mean opposite things to a holder (your money already arrived / this page and
 * the contract disagree) and must never be collapsed into "transaction failed".
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeErrorResult,
  type Abi,
  type Hex,
} from "viem";
import { build } from "./build-merkle.js";
import { leafHash, verifyAllocation, verifyProof } from "../src/lib/claim/merkle.js";
import { claimErrorMessage, exactAmount, formatNew, isTruncated } from "../src/lib/claim/format.js";
import { DISTRIBUTOR_ABI, chainMeta, explorerAddress, explorerTx } from "../src/lib/claim/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "fixtures/claim-allocations.fixture.csv");

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
}

function eq<T>(actual: T, expected: T, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

const csv = readFileSync(FIXTURE, "utf8");
const built = build(csv, { aggregate: false });

console.log("\n1. VERIFIER — the browser must agree with the tree builder");

check("every proof the builder emits verifies in the browser implementation", () => {
  let n = 0;
  for (const [addr, p] of Object.entries(built.proofs)) {
    if (!verifyAllocation(built.root as Hex, p.index, addr as Hex, p.amount, p.proof))
      throw new Error(`proof for ${addr} (index ${p.index}) failed browser-side verification`);
    n++;
  }
  eq(n, built.rows.length, "verified count");
});

check("the browser leaf hash equals the tree's own leaf hash, for every row", () => {
  for (const [, value] of built.tree.entries()) {
    const [index, account, amount] = value;
    eq(
      leafHash(BigInt(index), account as Hex, amount),
      built.tree.leafHash(value) as Hex,
      `leaf ${index}`,
    );
  }
});

check("a tampered amount is rejected", () => {
  const [addr, p] = Object.entries(built.proofs)[0];
  const bumped = (BigInt(p.amount) + 1n).toString();
  if (verifyAllocation(built.root as Hex, p.index, addr as Hex, bumped, p.proof))
    throw new Error("a tampered amount verified — the page would offer a button that reverts");
});

check("another wallet's proof is rejected for this address", () => {
  const entries = Object.entries(built.proofs);
  const [addrA, pA] = entries[0];
  const [, pB] = entries[1];
  if (verifyAllocation(built.root as Hex, pA.index, addrA as Hex, pA.amount, pB.proof))
    throw new Error("a foreign proof verified");
});

check("a wrong index is rejected", () => {
  const [addr, p] = Object.entries(built.proofs)[0];
  if (verifyAllocation(built.root as Hex, p.index + 1, addr as Hex, p.amount, p.proof))
    throw new Error("a wrong index verified");
});

check("verification is case-insensitive on the address and the proof", () => {
  const [addr, p] = Object.entries(built.proofs)[0];
  const upperProof = p.proof.map((h) => ("0x" + h.slice(2).toUpperCase()) as Hex);
  if (!verifyAllocation(built.root.toUpperCase().replace("0X", "0x") as Hex, p.index, addr.toUpperCase().replace("0X", "0x") as Hex, p.amount, upperProof))
    throw new Error("case variation broke verification — real proofs.json casing would fail");
});

check("an empty proof only verifies for a single-leaf tree", () => {
  const [addr, p] = Object.entries(built.proofs)[0];
  if (verifyProof(built.root as Hex, leafHash(p.index, addr as Hex, p.amount), []))
    throw new Error("an empty proof verified against a multi-leaf root");
});

console.log("\n2. FORMATTER — a nonzero allocation must never render as zero");

check("1 wei renders every digit, not '0'", () => {
  eq(formatNew(1n), "0.000000000000000001", "1 wei");
});

check("the fixture's dust row survives formatting", () => {
  const dust = Object.values(built.proofs).find((p) => p.amount === "1");
  if (!dust) throw new Error("fixture lost its 1-wei row");
  if (formatNew(BigInt(dust.amount)) === "0") throw new Error("dust allocation rendered as 0");
});

check("zero renders as '0'", () => eq(formatNew(0n), "0", "zero"));
check("one whole token renders as '1'", () => eq(formatNew(10n ** 18n), "1", "1 token"));

check("thousands are grouped and cents kept", () => {
  eq(formatNew(1_234_567_890_000_000_000_000_000n), "1,234,567.89", "1234567.89");
});

check("a sub-token amount keeps all its digits", () => {
  eq(formatNew(500_000_000_000_000n), "0.0005", "0.0005");
});

check("no float anywhere — a value past 2^53 tokens groups exactly", () => {
  // 12,345,678,901,234,567 tokens: far beyond Number's integer range.
  eq(formatNew(12_345_678_901_234_567n * 10n ** 18n), "12,345,678,901,234,567", "huge");
});

check("the 18-decimal boundary row formats and reports itself truncated", () => {
  const wei = 999_999_999_999_999_999_999_999n; // 999999.999999999999999999
  eq(formatNew(wei), "999,999.99", "boundary");
  eq(exactAmount(wei), "999999.999999999999999999", "exact");
  eq(isTruncated(wei), true, "isTruncated");
});

check("a clean amount is not reported truncated", () => {
  eq(isTruncated(10n ** 18n), false, "1 token");
  eq(isTruncated(1n), false, "1 wei");
  eq(isTruncated(1_500_000_000_000_000_000n), false, "1.5 tokens");
});

check("exactAmount round-trips the fixture total", () => {
  eq(exactAmount(built.totalWei), "13541576.8377", "fixture total");
});

console.log("\n3. REVERTS — opposite meanings must not collapse into one message");

function revertedWith(errorName: "AlreadyClaimed" | "InvalidProof"): BaseError {
  return new ContractFunctionRevertedError({
    abi: DISTRIBUTOR_ABI as unknown as Abi,
    data: encodeErrorResult({ abi: DISTRIBUTOR_ABI, errorName }),
    functionName: "claim",
  });
}

check("AlreadyClaimed says the money already arrived", () => {
  const msg = claimErrorMessage(revertedWith("AlreadyClaimed"));
  if (!/already been claimed/i.test(msg)) throw new Error(`unhelpful message: ${msg}`);
  if (/revert|0x[0-9a-f]{8}/i.test(msg)) throw new Error(`leaked raw revert detail: ${msg}`);
});

check("InvalidProof says do not retry, and says why", () => {
  const msg = claimErrorMessage(revertedWith("InvalidProof"));
  if (!/do not retry/i.test(msg)) throw new Error(`missing the actionable part: ${msg}`);
  if (!/does not match/i.test(msg)) throw new Error(`missing the cause: ${msg}`);
});

check("the two messages are not the same sentence", () => {
  if (claimErrorMessage(revertedWith("AlreadyClaimed")) === claimErrorMessage(revertedWith("InvalidProof")))
    throw new Error("AlreadyClaimed and InvalidProof collapsed into one message");
});

check("a revert nested inside an outer error is still found", () => {
  const outer = new BaseError("Something went wrong.", { cause: revertedWith("AlreadyClaimed") });
  if (!/already been claimed/i.test(claimErrorMessage(outer)))
    throw new Error("walk() did not reach the nested revert");
});

check("a user rejection reads as a rejection, not a failure", () => {
  const err = new BaseError("outer", { cause: new UserRejectedRequestError(new Error("denied")) });
  const msg = claimErrorMessage(err);
  if (!/rejected/i.test(msg) || !/nothing was sent/i.test(msg)) throw new Error(`bad message: ${msg}`);
});

check("insufficient gas funds is named as gas, not as a claim failure", () => {
  const msg = claimErrorMessage(new BaseError("insufficient funds for gas * price + value"));
  if (!/gas/i.test(msg)) throw new Error(`bad message: ${msg}`);
});

check("a plain Error passes through unchanged", () => {
  eq(claimErrorMessage(new Error("boom")), "boom", "plain error");
});

console.log("\n4. CONFIG — the chain guard and the link builders");

check("an unknown chain id returns null, so the page refuses to render a button", () => {
  eq(chainMeta(1), null, "ethereum mainnet");
  eq(chainMeta(999999), null, "nonsense chain");
});

check("Robinhood Chain 4663 is known and is not marked testnet", () => {
  const m = chainMeta(4663);
  if (!m) throw new Error("4663 missing");
  eq(m.isTestnet, false, "isTestnet");
  eq(m.explorer, "https://robinhoodchain.blockscout.com", "explorer");
});

check("every dry-run chain is marked testnet", () => {
  for (const id of [84532, 46630, 31337]) {
    const m = chainMeta(id);
    if (!m) throw new Error(`${id} missing`);
    eq(m.isTestnet, true, `isTestnet for ${id}`);
  }
});

check("a chain with no explorer yields no link instead of a dead one", () => {
  eq(explorerTx(31337, "0xabc"), null, "anvil tx link");
  eq(explorerAddress(31337, "0xabc"), null, "anvil address link");
});

check("explorer links are built for real chains", () => {
  eq(explorerTx(4663, "0xdead"), "https://robinhoodchain.blockscout.com/tx/0xdead", "rh tx");
  eq(explorerAddress(84532, "0xbeef"), "https://sepolia.basescan.org/address/0xbeef", "sepolia addr");
});

check("the ABI carries all four custom errors, or reverts render as hex", () => {
  const errors: string[] = DISTRIBUTOR_ABI.filter((x) => x.type === "error").map((x) => x.name);
  for (const n of ["AlreadyClaimed", "InvalidProof", "SweepBeforeDeadline", "ZeroAddress"]) {
    if (!errors.includes(n)) throw new Error(`missing error ${n} in ABI`);
  }
});

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
