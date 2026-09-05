/**
 * Browser-side merkle verification for the claim page.
 *
 * The page re-checks a holder's own proof locally before it offers a Claim
 * button. That check is worth ~8 lines because the alternative failure is
 * expensive and confusing: a corrupted or stale proofs.json produces a button
 * that looks completely normal, costs real gas, and reverts with `InvalidProof`
 * every single time. Catching it here turns that into a sentence.
 *
 * Reimplemented rather than importing @openzeppelin/merkle-tree so the claim
 * page does not ship a tree builder to the browser in order to verify one leaf.
 * The two must agree exactly, so `scripts/claim-verify-test.ts` runs every proof
 * the real builder emits through this file.
 */
import { concat, encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

/**
 * Byte-for-byte the leaf computed inside `MerkleDistributor.claim()`:
 *   keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
 *
 * Double-hashed, and `abi.encode` (padded) rather than `abi.encodePacked` —
 * see the contract's header comment for why the two are not interchangeable.
 */
export function leafHash(index: number | bigint, account: Hex, amountWei: string | bigint): Hex {
  return keccak256(
    concat([
      keccak256(
        encodeAbiParameters(parseAbiParameters("uint256, address, uint256"), [
          BigInt(index),
          // Lowercased before encoding, and this is load-bearing rather than
          // tidy. viem REJECTS a mixed-case address that fails its EIP-55
          // checksum — it throws rather than returning a bad hash. The leaf
          // commits to 20 bytes and the contract has no notion of casing at
          // all, so any casing is equally valid input here; without this,
          // an address arriving in a form viem dislikes (a proofs.json key
          // upper-cased by a spreadsheet, say) would throw mid-render instead
          // of simply verifying.
          account.toLowerCase() as Hex,
          BigInt(amountWei),
        ]),
      ),
    ]),
  );
}

/**
 * OpenZeppelin's sorted-pair proof verification — the same thing
 * `MerkleProof.verify` does on chain.
 *
 * Two bytes32 concatenated IS `abi.encode` of them (both are already 32 bytes,
 * so there is no padding to add), and lowercase hex-string ordering on equal-
 * length strings is the same ordering Solidity's `a < b` gives on bytes32. So
 * this agrees with the contract without reproducing its encoding twice.
 */
export function verifyProof(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  let computed = leaf.toLowerCase() as Hex;
  for (const raw of proof) {
    const sibling = raw.toLowerCase() as Hex;
    computed = (
      computed < sibling
        ? keccak256(concat([computed, sibling]))
        : keccak256(concat([sibling, computed]))
    ).toLowerCase() as Hex;
  }
  return computed === (root.toLowerCase() as Hex);
}

/** The whole check in one call: does this allocation belong to this root? */
export function verifyAllocation(
  root: Hex,
  index: number | bigint,
  account: Hex,
  amountWei: string | bigint,
  proof: readonly Hex[],
): boolean {
  return verifyProof(root, leafHash(index, account, amountWei), proof);
}
