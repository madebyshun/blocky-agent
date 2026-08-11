/**
 * One-shot backfill for arrow #0065 (Blue Hood P0.1 v3 landing 2026-07-24).
 *
 * The first real user swap was tx 0xa9bc…b80f — verified on chain:
 *   status: Success
 *   block:  18191886
 *   pool:   UniswapV3
 *   2 USDG → 0.017290478789673946 SPCX
 *   gas used 166,068 / limit 177,174 (93.73% — the reason we now add
 *   30% buffer, see P0.2 in the same PR)
 *
 * Before this PR the user_action was written with status="pending" (later
 * default "success") — this script re-POSTs the record with the real
 * receipt data so the historical row reads honestly under the v3
 * schema. Idempotent: the endpoint keys on tx_hash and upserts.
 *
 * Run: cd apps/web && npx tsx scripts/backfill-arrow-0065.ts
 *
 * The wallet + amount are the values the user shared; adjust below if
 * a different session ends up owning #0065.
 */

export {};

const ARROW_ID = "#0065";  // human-readable serial — the endpoint expects the KV id (uuid)
const TX_HASH = "0xa9bc…b80f";  // TODO: paste the FULL hash before running
const BLOCK   = 18191886;
const WALLET  = "0x…";  // TODO: paste the wallet that signed
const AMOUNT  = 2;
const SIDE: "buy" | "sell" = "buy";
const DENOM: "USDG" | "WETH" = "USDG";
const MIN_OUT = 0.01719167;

async function main() {
  console.log("═══ BACKFILL PLAN ═══");
  console.log(`arrow serial:  ${ARROW_ID}`);
  console.log(`tx_hash:       ${TX_HASH}`);
  console.log(`block_number:  ${BLOCK}`);
  console.log(`wallet:        ${WALLET}`);
  console.log(`side:          ${SIDE}`);
  console.log(`amount:        ${AMOUNT} ${DENOM}`);
  console.log(`min_out:       ${MIN_OUT}`);
  console.log();
  console.log("Before running:");
  console.log("  1. Paste the FULL tx hash (0x…64 hex chars) into TX_HASH above");
  console.log("  2. Paste the signing wallet into WALLET above");
  console.log("  3. Find the KV id (uuid) for arrow #0065 — hit");
  console.log("     https://blueagent.dev/api/hood/arrows?limit=100 and grep for serial=\"#0065\"");
  console.log("     Substitute that id into the fetch URL below");
  console.log();
  console.log("After the fields are filled, uncomment the fetch call and re-run.");

  // POST to the same endpoint the panel uses — the upsert path preserves
  // the original ts and rolls the status/revert_reason/block_number forward.
  //
  // const arrowKvId = "REPLACE_WITH_UUID";
  // const res = await fetch(`https://blueagent.dev/api/hood/arrows/${arrowKvId}/user-action`, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({
  //     wallet: WALLET,
  //     tx_hash: TX_HASH,
  //     side: SIDE,
  //     amount: AMOUNT,
  //     denom: DENOM,
  //     min_out: MIN_OUT,
  //     status: "success",
  //     block_number: BLOCK,
  //   }),
  // });
  // console.log(res.status, await res.text());
}

main().catch((e) => { console.error(e); process.exit(1); });
