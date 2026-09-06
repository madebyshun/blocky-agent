/**
 * JSON-RPC hex → decimal, computed on the SERVER.
 *
 * WHY THIS EXISTS
 * ---------------
 * MEASURED in prod 2026-09-06. Asked "what block is Base on?", the chat model
 * answered with a number ~20,000 blocks low. The tool was not wrong: the route
 * returned `0x3094173`, byte-identical to what `mainnet.base.org` returned in
 * the same minute. `0x3094173` is 50,938,227. The model did the base-16
 * conversion in its head and got a different number.
 *
 * That is not a prompt problem and no instruction fixes it. Asking a language
 * model to multiply seven hex digits by powers of sixteen is asking it to
 * generate a number, and CLAUDE.md is explicit that derived values are computed
 * in code — "the LLM only interprets — it NEVER generates the numbers."
 *
 * The failure is silent in the worst way: a wrong block height is perfectly
 * plausible. Nothing about `50,918,227` looks wrong next to `50,938,227`, so it
 * reads as a fetched fact. Same for a wei balance, where the error lands in
 * whichever digit the model fumbled and the answer can be off by an order of
 * magnitude with no visible tell.
 *
 * WHAT IS AND IS NOT DECODED
 * --------------------------
 * Only values whose type is fixed by the JSON-RPC spec. `eth_blockNumber` is
 * defined to return a QUANTITY, so decoding it is transcription, not inference.
 * `eth_call` returns bytes whose meaning depends on the ABI we were not told,
 * so a single 32-byte word is offered as `as_uint256` with an explicit caveat
 * that the token's decimals are unknown — a number plus a stated unknown, never
 * a scaled figure we guessed at.
 *
 * Nothing here mutates `result`. The decode rides alongside it, so a caller
 * that wants the raw RPC reply still has it untouched.
 */

import { formatEther, formatGwei } from "viem";

/** A hex QUANTITY per the JSON-RPC spec: 0x-prefixed, no leading zeros. */
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;

/**
 * Methods whose ENTIRE result is a single hex quantity.
 *
 * The unit is what the spec says the number counts, and it decides which extra
 * renderings are honest: `wei` earns an `ether` field, a gas price earns
 * `gwei`, a block height earns neither.
 */
const QUANTITY_METHODS: Record<string, Unit> = {
  eth_blockNumber: "block",
  eth_chainId: "chainId",
  eth_getBalance: "wei",
  eth_gasPrice: "wei-gas",
  eth_maxPriorityFeePerGas: "wei-gas",
  eth_estimateGas: "gas",
  eth_getTransactionCount: "count",
  eth_getBlockTransactionCountByNumber: "count",
  eth_getBlockTransactionCountByHash: "count",
  eth_getUncleCountByBlockNumber: "count",
  eth_getUncleCountByBlockHash: "count",
};

/**
 * Hex-quantity FIELDS inside object results (blocks, transactions, receipts,
 * logs). Every key here is a QUANTITY in the spec; hashes, addresses and
 * `input`/`data` byte strings are deliberately absent — they are hex that is
 * not a number, and turning `0xabc…` calldata into a decimal would be noise.
 */
const FIELD_UNITS: Record<string, Unit> = {
  blockNumber: "block",
  number: "block",
  chainId: "chainId",
  timestamp: "timestamp",
  value: "wei",
  gasPrice: "wei-gas",
  effectiveGasPrice: "wei-gas",
  maxFeePerGas: "wei-gas",
  maxPriorityFeePerGas: "wei-gas",
  baseFeePerGas: "wei-gas",
  gas: "gas",
  gasUsed: "gas",
  cumulativeGasUsed: "gas",
  gasLimit: "gas",
  blobGasUsed: "gas",
  excessBlobGas: "gas",
  nonce: "count",
  transactionIndex: "count",
  logIndex: "count",
  size: "count",
  status: "count",
  type: "count",
};

type Unit =
  | "block" | "chainId" | "wei" | "wei-gas" | "gas" | "count" | "timestamp";

export interface DecodedQuantity {
  hex: string;
  /** String, not number: a wei balance overflows IEEE-754 well before it
   *  overflows uint256, and JSON.stringify would round it silently. */
  decimal: string;
  unit: Unit;
  ether?: string;
  gwei?: string;
  /** ISO-8601 for a unix `timestamp`, so the model never does date maths either. */
  iso?: string;
}

/** One hex quantity → every rendering that is true of it, and no others. */
export function decodeQuantity(hex: string, unit: Unit): DecodedQuantity | null {
  if (typeof hex !== "string" || !HEX_QUANTITY.test(hex)) return null;
  // 32 bytes is the widest quantity the EVM has. Anything longer is a byte
  // string that happens to match the shape, not a number.
  if (hex.length > 66) return null;

  let n: bigint;
  try { n = BigInt(hex); } catch { return null; }

  const out: DecodedQuantity = { hex, decimal: n.toString(), unit };
  if (unit === "wei") out.ether = formatEther(n);
  if (unit === "wei-gas") out.gwei = formatGwei(n);
  if (unit === "timestamp") {
    const ms = Number(n) * 1000;
    if (Number.isFinite(ms) && ms > 0 && ms < 8.64e15) out.iso = new Date(ms).toISOString();
  }
  return out;
}

export interface Decoded {
  kind: "quantity" | "fields" | "list" | "word";
  /** Present for `kind: "quantity"` — the whole result was one number. */
  value?: DecodedQuantity;
  /** Present for `kind: "fields"` — the spec-typed numbers inside an object. */
  fields?: Record<string, DecodedQuantity>;
  /** Present for `kind: "list"` — one entry per array element that had any. */
  items?: Record<string, DecodedQuantity>[];
  /** Present for `kind: "word"` — a lone 32-byte eth_call return. */
  as_uint256?: string;
  caveat?: string;
  note: string;
}

/** The same sentence on every shape: the server did the arithmetic. */
const NOTE =
  "These decimal values were computed on the server from the hex above. "
  + "Quote them exactly as given — do NOT convert hex to decimal yourself, "
  + "and do not round, reformat or recompute them.";

function decodeFields(obj: Record<string, unknown>): Record<string, DecodedQuantity> {
  const fields: Record<string, DecodedQuantity> = {};
  for (const [k, v] of Object.entries(obj)) {
    const unit = FIELD_UNITS[k];
    if (!unit || typeof v !== "string") continue;
    const d = decodeQuantity(v, unit);
    if (d) fields[k] = d;
  }
  return fields;
}

/**
 * Build the `decoded` companion for one JSON-RPC result, or `null` when there
 * is nothing a decode could honestly add.
 *
 * `null` is a real answer — for `eth_getCode`, a hash, or an `eth_call` whose
 * return is not one word, there is no number to hand over, and inventing a
 * field would be worse than the absence.
 */
export function decodeRpcResult(method: string, result: unknown): Decoded | null {
  // 1. The whole result is a quantity — the eth_blockNumber case that started this.
  const unit = QUANTITY_METHODS[method];
  if (unit && typeof result === "string") {
    const value = decodeQuantity(result, unit);
    return value ? { kind: "quantity", value, note: NOTE } : null;
  }

  // 2. A lone 32-byte word from eth_call. Mechanically a uint256; what it MEANS
  //    needs an ABI we were not given, so the unknown is stated, not filled in.
  if (method === "eth_call" && typeof result === "string"
      && HEX_QUANTITY.test(result) && result.length === 66) {
    const d = decodeQuantity(result, "count");
    return d ? {
      kind: "word",
      as_uint256: d.decimal,
      caveat: "Raw base units, decimals UNKNOWN — this is the uint256 as stored. "
        + "For a token amount, divide by that token's decimals (call decimals() "
        + "to find it). Never present this as a token balance without doing so.",
      note: NOTE,
    } : null;
  }

  // 3. A block / transaction / receipt object.
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const fields = decodeFields(result as Record<string, unknown>);
    return Object.keys(fields).length ? { kind: "fields", fields, note: NOTE } : null;
  }

  // 4. eth_getLogs and friends. Positional: items[i] lines up with result[i],
  //    including the empty objects, so the model cannot mis-pair them.
  if (Array.isArray(result)) {
    const items = result.map((el) =>
      el && typeof el === "object" && !Array.isArray(el)
        ? decodeFields(el as Record<string, unknown>)
        : {});
    return items.some((i) => Object.keys(i).length)
      ? { kind: "list", items, note: NOTE }
      : null;
  }

  return null;
}
