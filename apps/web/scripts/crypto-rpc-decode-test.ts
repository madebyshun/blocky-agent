/**
 * hub_crypto_rpc — the server does the hex arithmetic, not the model (#207).
 *
 * WHY THIS EXISTS
 * ---------------
 * MEASURED in prod 2026-09-06. Asked what block Base was on, chat answered with
 * a height roughly 20,000 blocks low. The tool was NOT wrong — `/api/crypto-rpc`
 * returned `0x3094173`, byte-identical to what `mainnet.base.org` returned in
 * the same minute. `0x3094173` is 50,938,227. The model converted base-16 in its
 * head and produced a different, entirely plausible number.
 *
 * Underneath it sat a second bug that made the first one unavoidable: the chat
 * relay unwrapped `{ result: … }` before showing the model anything, so the
 * whole tool reply collapsed to the bare string `"0x3094173"`. No network, no
 * method, nothing to read but hex. `result` means opposite things in our x402
 * envelope and in JSON-RPC — a name collision between two protocols.
 *
 * WHAT WOULD ROT SILENTLY
 * -----------------------
 *   1. THE UNWRAP. It is one line and it looks like a tidy-up. Re-collapsing it
 *      re-hides every sibling key, and nothing fails to compile — the model just
 *      quietly goes back to converting hex. Asserted against route.ts source.
 *   2. DECODING TOO MUCH. The tempting next step is to decode every 0x string.
 *      Hashes, addresses and calldata are hex that is NOT a number; turning
 *      calldata into a decimal invents a quantity. Asserted as absence.
 *   3. THE eth_call CAVEAT. A lone 32-byte word is mechanically a uint256, but
 *      the token's decimals are unknown. Dropping the caveat turns a raw base
 *      unit into a "balance" off by 10^18 — a worse error than the one fixed.
 *   4. NUMBER PRECISION. A wei balance exceeds 2^53. If `decimal` ever becomes a
 *      JS number instead of a string, JSON.stringify rounds it and the answer is
 *      wrong in the low digits with no visible tell.
 *
 * Pure function + source read. No network.
 *
 * Run: npx tsx scripts/crypto-rpc-decode-test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeRpcResult, decodeQuantity } from "../src/app/api/crypto-rpc/decode";

const WEB = path.resolve(path.dirname(path.resolve(process.argv[1])), "..");
const read = (p: string) => readFileSync(path.join(WEB, p), "utf8");
const CHAT_ROUTE = read("src/app/api/chat/route.ts");
const RPC_ROUTE = read("src/app/api/crypto-rpc/route.ts");

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = "") {
  checks++;
  if (cond) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 1. The exact value that was misreported ──────────────────────────────────
console.log("\n1. the prod fixture decodes to the number Base actually reported");

// Captured 2026-09-06 from BOTH /api/crypto-rpc and mainnet.base.org — the two
// agreed exactly, which is what proves the tool was never the wrong half.
const BASE_BLOCK_HEX = "0x3094173";
const BASE_BLOCK_DEC = "50938227";

const block = decodeRpcResult("eth_blockNumber", BASE_BLOCK_HEX);
check("eth_blockNumber decodes to a quantity",
  block?.kind === "quantity" && block.value?.decimal === BASE_BLOCK_DEC,
  `${BASE_BLOCK_HEX} → ${block?.value?.decimal}`);
check("the hex is kept alongside, so the number stays checkable",
  block?.value?.hex === BASE_BLOCK_HEX);
check("a block height gets no ether/gwei rendering — it counts blocks",
  block?.value?.ether === undefined && block?.value?.gwei === undefined);

// ── 2. Units are what the spec says, not what the key looks like ─────────────
console.log("\n2. each quantity gets only the renderings that are true of it");

const bal = decodeRpcResult("eth_getBalance", "0x1bc16d674ec80000"); // 2 ETH
check("eth_getBalance decodes wei and formats ether",
  bal?.value?.decimal === "2000000000000000000" && bal?.value?.ether === "2",
  `ether=${bal?.value?.ether}`);
check("a wei balance is NOT given a gwei field", bal?.value?.gwei === undefined);

const gas = decodeRpcResult("eth_gasPrice", "0x3b9aca00"); // 1 gwei
check("eth_gasPrice formats gwei", gas?.value?.gwei === "1", `gwei=${gas?.value?.gwei}`);

const chainId = decodeRpcResult("eth_chainId", "0x2105");
check("eth_chainId decodes to 8453 — Base, and not by string-matching a name",
  chainId?.value?.decimal === "8453");
const rhChainId = decodeRpcResult("eth_chainId", "0x1237");
check("and to 4663 for Robinhood Chain", rhChainId?.value?.decimal === "4663");

// 2^53 + 1: the first integer a JS number cannot represent. A wei balance is
// routinely 10^18, far past this.
const big = decodeQuantity("0x20000000000001", "wei");
check("decimal is a STRING, so a wei balance is not silently rounded",
  typeof big?.decimal === "string" && big?.decimal === "9007199254740993",
  big?.decimal);

// ── 3. Objects: spec-typed fields only ───────────────────────────────────────
console.log("\n3. block/tx/receipt objects decode their quantity fields only");

const tx = decodeRpcResult("eth_getTransactionByHash", {
  blockNumber: "0x3094173",
  value: "0x2386f26fc10000", // 0.01 ETH
  gas: "0x5208",
  gasPrice: "0x3b9aca00",
  nonce: "0x2a",
  hash: "0xabc0000000000000000000000000000000000000000000000000000000000001",
  from: "0x0295aD38ADA1d599375bd447e080cd404809205a",
  input: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001",
});
check("tx quantity fields decode", tx?.kind === "fields"
  && tx.fields?.blockNumber?.decimal === BASE_BLOCK_DEC
  && tx.fields?.value?.ether === "0.01"
  && tx.fields?.gas?.decimal === "21000"
  && tx.fields?.nonce?.decimal === "42",
  `value=${tx?.fields?.value?.ether} ETH, gas=${tx?.fields?.gas?.decimal}`);
// This is the "decode too much" guard. `hash`, `from` and `input` are hex and
// are not numbers; a decimal for any of them would be a fabricated quantity.
check("hash / address / calldata are NOT decoded — hex is not always a number",
  tx?.fields?.hash === undefined && tx?.fields?.from === undefined
  && tx?.fields?.input === undefined);

// 0x6a9d55c0 = 1788696000 = 2026-09-06T12:00:00Z. Asserted in FULL, not by year
// prefix: a prefix match passes on any instant in a 12-month window, which is not
// a test of a conversion. (The first draft of this line did prefix-match, and the
// hex under it was a 2025 second — the weak assertion and the wrong fixture were
// the same mistake wearing two hats.)
const blk = decodeRpcResult("eth_getBlockByNumber", {
  number: "0x3094173",
  timestamp: "0x6a9d55c0",
  gasUsed: "0xf4240",
  baseFeePerGas: "0x3b9aca00",
});
check("a unix timestamp is rendered ISO — no date maths in the model's head",
  blk?.fields?.timestamp?.iso === "2026-09-06T12:00:00.000Z",
  blk?.fields?.timestamp?.iso);
check("and the seconds are kept too, so the ISO stays checkable",
  blk?.fields?.timestamp?.decimal === "1788696000");
check("baseFeePerGas is treated as a gas price, gasUsed as a count",
  blk?.fields?.baseFeePerGas?.gwei === "1"
  && blk?.fields?.gasUsed?.decimal === "1000000"
  && blk?.fields?.gasUsed?.gwei === undefined);

// ── 4. eth_call: a number plus a stated unknown ──────────────────────────────
console.log("\n4. eth_call gives the uint256 and refuses to guess decimals");

const word = decodeRpcResult("eth_call",
  "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000");
check("a lone 32-byte word decodes as uint256",
  word?.kind === "word" && word.as_uint256 === "1000000000000000000");
check("with the decimals caveat attached — raw base units, not a balance",
  /decimals UNKNOWN/i.test(word?.caveat ?? "")
  && /divide by that token's decimals/i.test(word?.caveat ?? ""));
check("no ether field is offered for an eth_call word — that would assume 18",
  !("ether" in (word ?? {})));

// Multi-word returns have an ABI shape we were not told. Absence is the honest
// answer; the model can say it cannot read it.
const multi = decodeRpcResult("eth_call", "0x" + "00".repeat(64));
check("a multi-word return decodes to null rather than a guess", multi === null);
check("eth_getCode is not decoded — bytecode is not a quantity",
  decodeRpcResult("eth_getCode", "0x60806040523480156100") === null);

// ── 5. Lists stay positional ─────────────────────────────────────────────────
console.log("\n5. eth_getLogs decodes per entry, positionally");

const logs = decodeRpcResult("eth_getLogs", [
  { blockNumber: "0x3094173", logIndex: "0x0" },
  { topics: ["0xddf2"] }, // nothing decodable
  { blockNumber: "0x3094174", logIndex: "0x2" },
]);
check("items line up index-for-index with result, empties included",
  logs?.kind === "list" && logs.items?.length === 3
  && logs.items[0].blockNumber?.decimal === BASE_BLOCK_DEC
  && Object.keys(logs.items[1]).length === 0
  && logs.items[2].logIndex?.decimal === "2");

// ── 6. Malformed input is refused, not coerced ───────────────────────────────
console.log("\n6. anything that is not a hex quantity decodes to null");

for (const bad of ["", "0x", "not-hex", "0xzz", "123"]) {
  check(`rejects ${JSON.stringify(bad)}`, decodeQuantity(bad, "count") === null);
}
check("rejects a >32-byte hex string that merely looks like a number",
  decodeQuantity("0x" + "f".repeat(65), "count") === null);
check("decodes the full uint256 range at exactly 32 bytes",
  decodeQuantity("0x" + "f".repeat(64), "count")?.decimal
    === (2n ** 256n - 1n).toString());

// ── 7. The plumbing that made this reachable ─────────────────────────────────
// Points 1 and 2 of the header: both are one-line reverts away, and neither
// breaks the build when reverted.
console.log("\n7. the decode actually reaches the model");

check("the chat relay does NOT unwrap a JSON-RPC reply",
  /"jsonrpc" in data/.test(CHAT_ROUTE)
  && /isJsonRpc \? data :/.test(CHAT_ROUTE));
check("the crypto-rpc route attaches `decoded` to the reply",
  /decodeRpcResult\(method, data\?\.result\)/.test(RPC_ROUTE)
  && /\.\.\.\(decoded \? \{ decoded \} : \{\}\)/.test(RPC_ROUTE));
// `result` is the RPC's own field. Rewriting it would break the protocol for
// any future caller; the decode is a sibling, deliberately.
check("`result` is passed through untouched — the decode rides alongside it",
  /\{ \.\.\.data, network: resolved/.test(RPC_ROUTE));
check("the tool description tells the model to quote decoded, never convert",
  /NEVER CONVERT HEX YOURSELF/.test(CHAT_ROUTE)
  && /decoded\.value\.decimal/.test(CHAT_ROUTE));

console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
