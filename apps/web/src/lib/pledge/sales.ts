/**
 * Sale batches — the public record of pledged tokens being sold to fund the
 * $NEW pool, and the arithmetic that turns that record into the airdrop split.
 *
 * `sale-batches.json` is hand-maintained: after each sale the operator adds a
 * row with its transaction hash. Everything rendered on /pledge is derived from
 * that file, so this module is the only place a number can be invented, and it
 * is deliberately written so that it cannot.
 *
 * ─── Why this validates instead of trusting the file ────────────────────────
 *
 * The split below decides what every pledger receives. A hand-edited JSON file
 * is exactly the kind of input that acquires a typo — a missing digit, a chain
 * key that is neither "rh" nor "base", an amount written "1,024.5". None of
 * those are type errors (`resolveJsonModule` widens every string to `string`),
 * so nothing would catch them and the page would publish a wrong split with
 * total confidence.
 *
 * So `loadSaleBatches()` throws on anything it does not recognise. It runs at
 * module scope in a server component, which means a malformed file fails the
 * BUILD rather than reaching a holder. That is the safe direction: a build that
 * does not ship is recoverable, a published allocation is not.
 *
 * ─── Why the arithmetic is BigInt ───────────────────────────────────────────
 *
 * Proceeds arrive as decimal strings and get summed. In float, 0.1 + 0.2 is
 * 0.30000000000000004, and the error compounds over a list. This is the same
 * reason `format.ts` refuses to divide raw token units in float. Amounts are
 * therefore parsed to fixed-point BigInt at `SCALE` decimals, summed exactly,
 * and only converted to a display string at the edge.
 */
import { CHAINS, type ChainKey } from "./config";
import raw from "./sale-batches.json";

/** Fixed-point scale for every parsed amount. Matches ERC-20 convention. */
const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);

export type ProceedsAsset = "VIRTUAL" | "WETH";

export interface SaleBatch {
  id: number;
  chain: ChainKey;
  /** ISO 8601, UTC. */
  date: string;
  /** Whole old-$BLUEAGENT tokens sold, decimal string. */
  tokensSold: string;
  received: { asset: ProceedsAsset; amount: string };
  /**
   * Base batches only: the WETH proceeds swapped to VIRT, with the swap tx.
   * `null` means the swap has not happened yet — see `pendingSwapCount`.
   */
  swappedToVirt: { amount: string; txHash: string } | null;
  txHash: string;
}

/** A batch with its amounts parsed to fixed-point, ready to sum. */
export interface SaleBatchRow extends SaleBatch {
  tokensSoldScaled: bigint;
  receivedScaled: bigint;
  /** Proceeds expressed in VIRT, or null when not yet known. */
  virtScaled: bigint | null;
  /** received / tokensSold, in `received.asset` per token, scaled. */
  avgPriceScaled: bigint;
}

export interface SaleTotals {
  /** VIRT raised on Robinhood Chain — proceeds arrive as VIRTUAL already. */
  virtRh: bigint;
  /** VIRT raised on Base, counting only batches whose swap has settled. */
  virtBase: bigint;
  /** WETH received on Base, including batches still awaiting their swap. */
  wethBase: bigint;
  tokensSoldRh: bigint;
  tokensSoldBase: bigint;
  /**
   * Base batches sold but not yet swapped to VIRT. Their VIRT value is UNKNOWN,
   * so they are excluded from `virtBase` and from the split — counting them as
   * zero would understate Base's share of an allocation that is already being
   * published. The UI has to say how many are outstanding.
   */
  pendingSwapCount: number;
  /** Split in basis points; the two always sum to exactly 10000. */
  splitRhBps: number;
  splitBaseBps: number;
  /** False when nothing has settled in VIRT yet, so no split exists at all. */
  splitKnown: boolean;
}

/* ─── decimal ⇄ fixed-point ─────────────────────────────────────────────── */

function parseDecimal(input: unknown, field: string): bigint {
  if (typeof input !== "string" || !/^\d+(\.\d+)?$/.test(input)) {
    throw new Error(
      `sale-batches.json: ${field} must be a plain decimal string ` +
        `(no sign, no separators, no exponent), got ${JSON.stringify(input)}`,
    );
  }
  const [whole, frac = ""] = input.split(".");
  if (frac.length > SCALE) {
    throw new Error(
      `sale-batches.json: ${field} has ${frac.length} decimal places, max ${SCALE}`,
    );
  }
  return BigInt(whole + frac.padEnd(SCALE, "0"));
}

/**
 * Fixed-point → display, with thousands separators.
 *
 * `maxFrac` is capped rather than fixed so a value that is genuinely round does
 * not render trailing zeros, and `minSignificant` guarantees a small-but-real
 * amount never displays as "0" — the same floor rule `fmtPct` enforces, for the
 * same reason: a number the page prints as nothing is worse than no column.
 */
export function formatScaled(v: bigint, maxFrac = 2): string {
  if (v === 0n) return "0";
  const digits = v.toString().padStart(SCALE + 1, "0");
  const whole = digits.slice(0, digits.length - SCALE);
  const frac = digits.slice(digits.length - SCALE);

  // Below 1, keep four significant digits instead of `maxFrac` decimals, so a
  // per-token price like 0.0000162 does not round to 0.00.
  let keep = maxFrac;
  if (whole === "0") {
    const leadingZeros = frac.length - frac.replace(/^0+/, "").length;
    keep = Math.min(SCALE, leadingZeros + 4);
  }

  const shown = frac.slice(0, keep).replace(/0+$/, "");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return shown ? `${grouped}.${shown}` : grouped;
}

export function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

/* ─── load + validate ───────────────────────────────────────────────────── */

function isChainKey(v: unknown): v is ChainKey {
  return typeof v === "string" && v in CHAINS;
}

function validate(input: unknown, index: number): SaleBatch {
  const b = input as Record<string, unknown>;
  const at = `batches[${index}]`;

  if (typeof b?.id !== "number" || !Number.isInteger(b.id) || b.id < 1) {
    throw new Error(`sale-batches.json: ${at}.id must be a positive integer`);
  }
  if (!isChainKey(b.chain)) {
    throw new Error(
      `sale-batches.json: ${at}.chain must be one of ${Object.keys(CHAINS).join(", ")}`,
    );
  }
  if (typeof b.date !== "string" || Number.isNaN(Date.parse(b.date))) {
    throw new Error(`sale-batches.json: ${at}.date must be an ISO 8601 timestamp`);
  }
  if (typeof b.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.txHash)) {
    throw new Error(`sale-batches.json: ${at}.txHash must be a 32-byte 0x hash`);
  }

  const received = b.received as Record<string, unknown> | undefined;
  if (received?.asset !== "VIRTUAL" && received?.asset !== "WETH") {
    throw new Error(`sale-batches.json: ${at}.received.asset must be VIRTUAL or WETH`);
  }

  // A batch that sold nothing, or raised nothing, is a mistyped row rather than
  // a real event — and `tokensSold` is a divisor, so zero would also be fatal.
  if (parseDecimal(b.tokensSold, `${at}.tokensSold`) <= 0n) {
    throw new Error(`sale-batches.json: ${at}.tokensSold must be greater than zero`);
  }
  if (parseDecimal(received.amount, `${at}.received.amount`) <= 0n) {
    throw new Error(`sale-batches.json: ${at}.received.amount must be greater than zero`);
  }

  const swap = b.swappedToVirt as Record<string, unknown> | null | undefined;
  if (swap != null) {
    if (typeof swap.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(swap.txHash)) {
      throw new Error(`sale-batches.json: ${at}.swappedToVirt.txHash must be a 32-byte 0x hash`);
    }
    if (parseDecimal(swap.amount, `${at}.swappedToVirt.amount`) <= 0n) {
      throw new Error(`sale-batches.json: ${at}.swappedToVirt.amount must be greater than zero`);
    }
  }

  // RH proceeds are VIRTUAL already, so a swap there would be describing a
  // trade that did not happen — and it would be double-counted as VIRT.
  if (b.chain === "rh" && swap != null) {
    throw new Error(
      `sale-batches.json: ${at} is on Robinhood Chain, where proceeds are ` +
        `already VIRTUAL — swappedToVirt must be null`,
    );
  }

  return {
    id: b.id,
    chain: b.chain,
    date: b.date,
    tokensSold: b.tokensSold as string,
    received: { asset: received.asset, amount: received.amount as string },
    swappedToVirt: swap
      ? { amount: swap.amount as string, txHash: swap.txHash as string }
      : null,
    txHash: b.txHash,
  };
}

/**
 * Read, validate and sort the batches. Throws on a malformed file.
 *
 * Sorted by `id` so the published numbering is what the page shows, regardless
 * of the order rows were appended in. Duplicate ids are rejected: two batches
 * sharing a number makes the record ambiguous to anyone auditing it.
 *
 * `input` defaults to the committed file and exists so `scripts/sale-batches-test.ts`
 * can drive the same validation with deliberately-broken fixtures. The rejections
 * are the point of this function, and a rejection path that is never executed is
 * not a rejection path.
 */
export function loadSaleBatches(input: unknown = raw): SaleBatchRow[] {
  const list = (input as { batches?: unknown } | null)?.batches;
  if (!Array.isArray(list)) {
    throw new Error("sale-batches.json: `batches` must be an array");
  }

  const batches = list.map(validate);
  const ids = new Set<number>();
  for (const b of batches) {
    if (ids.has(b.id)) throw new Error(`sale-batches.json: duplicate batch id ${b.id}`);
    ids.add(b.id);
  }

  return batches
    .sort((a, b) => a.id - b.id)
    .map((b) => {
      const tokensSoldScaled = parseDecimal(b.tokensSold, "tokensSold");
      const receivedScaled = parseDecimal(b.received.amount, "received.amount");
      return {
        ...b,
        tokensSoldScaled,
        receivedScaled,
        virtScaled:
          b.received.asset === "VIRTUAL"
            ? receivedScaled
            : b.swappedToVirt
              ? parseDecimal(b.swappedToVirt.amount, "swappedToVirt.amount")
              : null,
        avgPriceScaled: (receivedScaled * ONE) / tokensSoldScaled,
      };
    });
}

/**
 * Totals and the provisional airdrop split.
 *
 * The split is `V_RH / (V_RH + V_BASE)` in basis points, and Base is taken as
 * the remainder rather than computed independently — two roundings of the same
 * ratio can otherwise print as 62.4% / 37.7%, which reads as an error in a
 * number nobody can afford to distrust.
 */
export function computeTotals(rows: SaleBatchRow[]): SaleTotals {
  let virtRh = 0n;
  let virtBase = 0n;
  let wethBase = 0n;
  let tokensSoldRh = 0n;
  let tokensSoldBase = 0n;
  let pendingSwapCount = 0;

  for (const r of rows) {
    if (r.chain === "rh") {
      tokensSoldRh += r.tokensSoldScaled;
      virtRh += r.virtScaled ?? 0n;
    } else {
      tokensSoldBase += r.tokensSoldScaled;
      wethBase += r.receivedScaled;
      if (r.virtScaled === null) pendingSwapCount += 1;
      else virtBase += r.virtScaled;
    }
  }

  const denom = virtRh + virtBase;
  const splitKnown = denom > 0n;
  const splitRhBps = splitKnown ? Number((virtRh * 10_000n) / denom) : 0;

  return {
    virtRh,
    virtBase,
    wethBase,
    tokensSoldRh,
    tokensSoldBase,
    pendingSwapCount,
    splitRhBps,
    splitBaseBps: splitKnown ? 10_000 - splitRhBps : 0,
    splitKnown,
  };
}
