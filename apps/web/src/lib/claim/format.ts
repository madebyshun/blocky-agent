/**
 * Claim-page presentation — pure, no I/O, no React.
 *
 * Two jobs, both of which the page gets wrong in a way nobody notices if they
 * live inside a component: rendering an allocation, and turning a chain revert
 * into a sentence. Both are asserted by `scripts/claim-format-test.ts`.
 */
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { rawToDecimalString } from "@/lib/pledge/format";

/**
 * Exact decimal string for an amount in raw units. Re-exported from the pledge
 * formatter rather than reimplemented: it is the same string-surgery rule
 * (never `Number(raw) / 1e18`, which loses digits at these magnitudes), and two
 * copies of it would be two chances to drift on a page that pays out money.
 */
export const exactAmount = (wei: bigint, decimals = 18): string =>
  rawToDecimalString(wei.toString(), decimals);

/**
 * Human-readable allocation.
 *
 * The rule that matters: a nonzero allocation must NEVER render as "0".
 * `formatAmount` in the pledge formatter caps at 6 fraction digits, which turns
 * a 1-wei allocation into "0" — on the page whose entire job is paying that
 * allocation out. So below one whole token this prints every digit, and above
 * it prints two, with the exact value shown alongside on the page either way.
 *
 * All string surgery, no float, at any magnitude.
 */
export function formatNew(wei: bigint, decimals = 18): string {
  const exact = exactAmount(wei, decimals);
  const [whole, frac = ""] = exact.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  // Under one whole token: keep every digit. Truncating here is precisely how
  // dust renders as nothing.
  if (whole === "0" || whole === "-0") {
    return frac ? `${whole}.${frac}` : whole;
  }
  if (!frac) return grouped;
  return `${grouped}.${frac.slice(0, 2).padEnd(2, "0")}`;
}

/**
 * True when `formatNew` actually DROPPED digits, so the page can print the
 * exact value underneath.
 *
 * Derived from `formatNew` rather than re-deciding the rule, so the two cannot
 * drift apart. The one subtlety is the zero padding: `formatNew` renders 1.5
 * tokens as "1.50", which is the same number, not a truncation — comparing the
 * strings naively flags every clean amount and prints a pointless "exactly 1.5"
 * on rows where nothing was lost.
 */
export function isTruncated(wei: bigint, decimals = 18): boolean {
  const shown = formatNew(wei, decimals).replace(/,/g, "");
  const normalized = shown.includes(".") ? shown.replace(/0+$/, "").replace(/\.$/, "") : shown;
  return normalized !== exactAmount(wei, decimals);
}

/**
 * Chain error → one sentence a holder can act on.
 *
 * Every branch here answers "what do I do now", because the default — a hex
 * selector, or viem's `execution reverted` — answers nothing and reads like the
 * site broke. The two that matter most are opposites: AlreadyClaimed means the
 * money already arrived and there is nothing to fix, while InvalidProof means
 * this page and the contract disagree about the allocation table, which no
 * amount of retrying will resolve and which someone needs to be told about.
 */
export function claimErrorMessage(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) {
      return "You rejected the transaction in your wallet. Nothing was sent and your allocation is untouched.";
    }

    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      switch (reverted.data?.errorName) {
        case "AlreadyClaimed":
          return "This allocation has already been claimed. The tokens were sent to this address by an earlier transaction — check the address on the explorer.";
        case "InvalidProof":
          return "The contract rejected the proof for this address. That means the allocation table this page loaded does not match the one the contract was deployed with. Do not retry — report it on X @blueagent_.";
        case "SweepBeforeDeadline":
          return "The claim deadline has not passed. (This error should not be reachable from a claim — report it.)";
        case "ZeroAddress":
          return "The contract rejected a zero address. (This error should not be reachable from a claim — report it.)";
      }
      if (reverted.reason) return reverted.reason;
    }

    const msg = `${err.shortMessage || err.message}`;
    if (/insufficient funds/i.test(msg)) {
      return "Not enough native ETH in this wallet to pay for gas. Claiming itself is free, but the transaction still needs gas on this chain.";
    }
    return msg;
  }

  return err instanceof Error ? err.message : String(err);
}
