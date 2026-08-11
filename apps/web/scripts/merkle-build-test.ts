/**
 * scripts/merkle-build-test.ts — `npm run test:merkle`
 *
 * The merkle build has one property that matters more than all the others: the
 * root it produces must commit to exactly the allocations in the CSV, and the
 * proofs it emits must verify against the Solidity that pays them out. Nothing
 * downstream can detect a violation — a wrong root deploys cleanly, serves
 * cleanly, and simply fails every claim, permanently, on an immutable contract.
 *
 * So this file checks three separable things:
 *
 *   1. PINNED ROOT — a fixture CSV must produce one specific root. This catches
 *      any change to leaf encoding, index assignment, or row ordering, all of
 *      which are invisible in the output but repudiate every published proof.
 *
 *   2. LEAF PARITY WITH SOLIDITY — the leaf hash is recomputed here with viem,
 *      using the exact expression written in MerkleDistributor.claim(), and
 *      compared against what @openzeppelin/merkle-tree produced. This is the
 *      one test that would have caught the mistake the contract's own docs warn
 *      about: Uniswap's original uses keccak256(abi.encodePacked(...)) while OZ
 *      uses keccak256(keccak256(abi.encode(...))), and a distributor built from
 *      both halves of that sentence verifies precisely nothing.
 *
 *   3. THE REFUSALS — every malformed input the script promises to reject must
 *      actually throw. A validator that silently passes is worse than none,
 *      because the summary it prints then looks like confirmation.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, keccak256, parseAbiParameters, concat } from "viem";
import { build, parseCsv, parseAmount, parseAddress } from "./build-merkle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "fixtures/claim-allocations.fixture.csv");

/**
 * The root of the fixture CSV. Pinned, not computed — a test that recomputes
 * the value it asserts is a test that passes through any change to the thing
 * it is guarding. If a legitimate change to the leaf schema lands, this
 * constant is updated in the same commit, in the diff, on purpose.
 */
const EXPECTED_ROOT = "0x21c91829a215a6d27e81891ecda7d8aa056330b5aeacb0a6912f282cc912890a";

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

/** Asserts fn() throws, and that the message mentions `contains`. */
function throws(fn: () => unknown, contains: string) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.toLowerCase().includes(contains.toLowerCase())) {
      throw new Error(`threw, but message did not mention "${contains}": ${msg}`);
    }
  }
  if (!threw) throw new Error(`expected a throw mentioning "${contains}", but it returned normally`);
}

const csv = readFileSync(FIXTURE, "utf8");

console.log("\n1. ROOT — pinned, deterministic, content-addressed");
check("fixture CSV produces the pinned root", () => {
  eq(build(csv, { aggregate: false }).root, EXPECTED_ROOT, "root");
});

check("root is stable across row reordering (sorted by address, not by line)", () => {
  const lines = csv.trim().split("\n");
  const header = lines[0];
  const body = lines.slice(1).reverse(); // any permutation will do; reverse is deterministic
  eq(build([header, ...body].join("\n") + "\n", { aggregate: false }).root, EXPECTED_ROOT, "reversed-CSV root");
});

check("root is stable across whitespace and a trailing blank line", () => {
  const noisy = csv.replace(/\n/g, "  \n") + "\n\n";
  eq(build(noisy, { aggregate: false }).root, EXPECTED_ROOT, "whitespace-CSV root");
});

check("address case does not affect the root", () => {
  const lower = csv
    .split("\n")
    .map((l, i) => (i === 0 || l.trim() === "" ? l : l.replace(/^0x[0-9a-fA-F]{40}/, (m) => m.toLowerCase())))
    .join("\n");
  eq(build(lower, { aggregate: false }).root, EXPECTED_ROOT, "lowercased-CSV root");
});

console.log("\n2. LEAF — the encoding the Solidity actually verifies against");
check("leaf == keccak256(keccak256(abi.encode(index,address,amount))) for every row", () => {
  const r = build(csv, { aggregate: false });
  for (const [treeIdx, value] of r.tree.entries()) {
    const [index, account, amount] = value;
    // Byte-for-byte the expression in MerkleDistributor.claim().
    const solidityLeaf = keccak256(
      concat([
        keccak256(
          encodeAbiParameters(parseAbiParameters("uint256, address, uint256"), [
            BigInt(index),
            account as `0x${string}`,
            BigInt(amount),
          ]),
        ),
      ]),
    );
    eq(solidityLeaf, r.tree.leafHash(value), `leaf for tree index ${treeIdx}`);
  }
});

check("every emitted proof verifies against the root", () => {
  const r = build(csv, { aggregate: false });
  const dumped = StandardMerkleTree.load(r.tree.dump());
  for (const [addr, p] of Object.entries(r.proofs)) {
    const ok = StandardMerkleTree.verify(
      r.root,
      ["uint256", "address", "uint256"],
      [String(p.index), addr, p.amount],
      p.proof,
    );
    if (!ok) throw new Error(`proof for ${addr} failed to verify`);
  }
  eq(dumped.root, r.root, "reloaded tree root");
});

check("a proof does not verify for a different amount", () => {
  const r = build(csv, { aggregate: false });
  const [addr, p] = Object.entries(r.proofs)[0];
  const ok = StandardMerkleTree.verify(
    r.root,
    ["uint256", "address", "uint256"],
    [String(p.index), addr, (BigInt(p.amount) + 1n).toString()],
    p.proof,
  );
  if (ok) throw new Error("a tampered amount verified — the tree is not binding");
});

console.log("\n3. CONTENT — totals, indices, envelope");
check("indices are 0..n-1 with no gaps or repeats", () => {
  const r = build(csv, { aggregate: false });
  const idx = Object.values(r.proofs).map((p) => p.index).sort((a, b) => a - b);
  eq(idx.length, r.rows.length, "proof count");
  idx.forEach((v, i) => eq(v, i, `index at position ${i}`));
});

check("totalWei equals the sum of every allocation", () => {
  const r = build(csv, { aggregate: false });
  const sum = Object.values(r.proofs).reduce((a, p) => a + BigInt(p.amount), 0n);
  eq(r.totalWei, sum, "totalWei");
  eq(r.totalWei, 13_541_576_837_700_000_000_000_000n, "fixture total");
});

check("1 wei survives the round trip (no float anywhere in the path)", () => {
  const r = build(csv, { aggregate: false });
  const wei1 = Object.values(r.proofs).find((p) => p.amount === "1");
  if (!wei1) throw new Error("the 1-wei allocation was lost or rounded away");
});

check("proof keys are lowercased addresses", () => {
  const r = build(csv, { aggregate: false });
  for (const k of Object.keys(r.proofs)) {
    if (k !== k.toLowerCase()) throw new Error(`proof key is not lowercased: ${k}`);
    if (!/^0x[0-9a-f]{40}$/.test(k)) throw new Error(`proof key is not an address: ${k}`);
  }
});

console.log("\n4. REFUSALS — every documented rejection actually rejects");
const H = "wallet,chain,new_amount\n";
const A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

check("duplicate wallet fails loudly by default", () => {
  throws(() => build(`${H}${A},base,10\n${A},rh,5\n`, { aggregate: false }), "already appears");
});

check("--aggregate sums duplicates and records the merge", () => {
  const r = build(`${H}${A},base,10\n${A},rh,5\n`, { aggregate: true });
  eq(r.rows.length, 1, "row count");
  eq(r.rows[0].amountWei, 15_000_000_000_000_000_000n, "summed amount");
  eq(r.aggregated.length, 1, "aggregated record count");
  eq(r.aggregated[0].chains.join("+"), "base+rh", "merged chains");
});

check("zero amount rejected", () => throws(() => build(`${H}${A},base,0\n`, { aggregate: false }), "is zero"));
check("zero-with-decimals rejected", () => throws(() => build(`${H}${A},base,0.0\n`, { aggregate: false }), "is zero"));
check("negative amount rejected", () => throws(() => parseAmount("-5", 1), "not a plain decimal"));
check("exponent notation rejected", () => throws(() => parseAmount("1e18", 1), "not a plain decimal"));
check("thousands separator rejected", () => throws(() => parseAmount("1,000", 1), "not a plain decimal"));
check("19 decimal places rejected (would silently truncate)", () =>
  throws(() => parseAmount("1.0000000000000000009", 1), "19 decimal places"));
check("exactly 18 decimal places accepted", () => {
  eq(parseAmount("1.000000000000000001", 1), 1_000_000_000_000_000_001n, "18dp amount");
});

check("bad EIP-55 checksum rejected", () => {
  // Valid hex, valid length, mixed case, one character's case flipped.
  throws(() => parseAddress("0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266", 1), "checksum");
});
check("all-lowercase address accepted (carries no checksum)", () => {
  eq(parseAddress(A.toLowerCase(), 1), A, "normalised address");
});
check("all-uppercase address accepted (carries no checksum)", () => {
  eq(parseAddress("0x" + A.slice(2).toUpperCase(), 1), A, "normalised address");
});
check("correctly checksummed mixed-case address accepted", () => eq(parseAddress(A, 1), A, "address"));
check("truncated address rejected", () => throws(() => parseAddress("0xf39Fd6e5", 1), "not a 20-byte hex address"));

check("wrong field count rejected", () => {
  throws(() => build(`${H}${A},base\n`, { aggregate: false }), "expected 3 fields");
  throws(() => build(`${H}${A},base,10,extra\n`, { aggregate: false }), "expected 3 fields");
});
check("empty chain rejected", () => throws(() => build(`${H}${A},,10\n`, { aggregate: false }), "chain is empty"));
check("wrong header rejected", () =>
  throws(() => build(`address,chain,amount\n${A},base,10\n`, { aggregate: false }), "header must be exactly"));
check("header-only CSV rejected", () =>
  throws(() => build(H, { aggregate: false }), "no allocation rows"));
check("blank line between rows is tolerated", () => {
  const r = build(`${H}${A},base,10\n\n${B},rh,5\n`, { aggregate: false });
  eq(r.rows.length, 2, "row count");
});

check("error messages carry the offending line number", () => {
  throws(() => build(`${H}${A},base,10\n${B},rh,0\n`, { aggregate: false }), "line 3");
});

check("a two-leaf tree still produces working proofs (smallest real case)", () => {
  const r = build(`${H}${A},base,10\n${B},rh,5\n`, { aggregate: false });
  for (const [addr, p] of Object.entries(r.proofs)) {
    const ok = StandardMerkleTree.verify(r.root, ["uint256", "address", "uint256"], [String(p.index), addr, p.amount], p.proof);
    if (!ok) throw new Error(`proof for ${addr} failed in a 2-leaf tree`);
  }
});

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
