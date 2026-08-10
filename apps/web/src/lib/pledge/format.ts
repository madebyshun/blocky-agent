/**
 * Presentation of pledge numbers — pure, no I/O, shared by server and client.
 *
 * These live apart from `ledger.ts` for two reasons. `ledger.ts` imports the KV
 * client, so a client component importing it would drag server code into the
 * browser bundle. And more importantly: the rules below are the ones most
 * likely to quietly lie, so they belong somewhere `scripts/pledge-ledger-test.ts`
 * can assert against them directly. A formatting rule that exists only as a
 * comment inside a React component is a rule nothing enforces.
 */
import { formatUnits } from "viem";

/**
 * Raw units → decimal string, by string surgery rather than float division.
 *
 * `Number(raw) / 10 ** 18` loses digits well below the size of the pledges here
 * (2^53 is ~9.0e15, and one whole token is already 1e18 raw units). This is the
 * value people paste into a spreadsheet and sum, so it must be exact.
 */
export function rawToDecimalString(raw: string, decimals: number): string {
  const neg = raw.startsWith("-");
  const digits = (neg ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Human amount. Big pledges get thousands separators and 2dp; dust gets 6dp so
 * a small holder never sees their pledge rendered as "0".
 */
export function formatAmount(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(n)) return formatUnits(raw, decimals);
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 6 : 2,
  });
}

/**
 * Percent of supply, kept in BigInt until the last step.
 *
 * The scale factor decides the precision: multiplying by 1e12 before the
 * integer division keeps roughly ten significant digits on a share well under
 * one percent — far past anything printed. Dividing in float first, against a
 * 1e29 denominator, is what loses them.
 */
export function pctOfSupply(amount: bigint, supply: bigint): number {
  if (supply <= 0n) return 0;
  return (Number((amount * 1_000_000_000_000n) / supply) / 1e12) * 100;
}

/**
 * Percent → display string.
 *
 * The one rule: a nonzero pledge must never render as zero. The source app
 * printed `pctOfSupply.toFixed(4)`, which showed every Base holder below
 * ~100,000 tokens as "0.0000%" — a real pledge displayed as nothing on the
 * page whose entire job is proving it exists. Small shares therefore fall
 * through to a floor ("< 0.0001%") rather than being rounded down.
 */
export function fmtPct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return "0%";
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(3)}%`;
  if (pct >= 0.0001) return `${pct.toFixed(5)}%`;
  return "< 0.0001%";
}

/**
 * Old tokens → new tokens at a chain's fixed ratio (`CHAINS[c].oldPerNew`).
 *
 * Integer division, so it truncates DOWN. That direction is not an accident:
 * rounding up would hand out fractions of a token that the new supply does not
 * contain, and doing that once per pledger is how an airdrop ends up short for
 * whoever claims last. At 18 decimals the discarded remainder is sub-wei.
 *
 * Nothing renders this yet — `ALLOCATION_ANNOUNCED` is false. It exists now so
 * that the invariant it has to satisfy (a pledger's share of the old supply
 * equals their share of the new one) is asserted by the test suite BEFORE any
 * number derived from it is ever shown to a holder.
 */
export function convertToNew(rawOld: string, oldPerNew: bigint): string {
  if (oldPerNew <= 0n) throw new Error("oldPerNew must be positive");
  return (BigInt(rawOld) / oldPerNew).toString();
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export function fmtWhen(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function fmtAge(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
