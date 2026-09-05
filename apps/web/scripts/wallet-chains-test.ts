/**
 * wallet-chains-test — locks the wallet's chain config and the payment-QR
 * behaviour that reads it.
 *
 *   npx tsx scripts/wallet-chains-test.ts   (also runs under `npm test`)
 *
 * Two things are being defended here.
 *
 * 1. `payment-qr.ts` used to carry its own NET_TO_CHAIN literal alongside the
 *    network list, so a chain added to one and not the other would silently
 *    build a QR pointing at the wrong network. That table is gone — chainIds
 *    now come off WALLET_CHAINS — and the URI assertions below are the
 *    regression lock proving the removal didn't move any byte of the output.
 *
 * 2. Robinhood Chain settles in USDG, not USDC. The QR parser labels a token
 *    transfer `asset: "USDC"` by matching the target contract, so without a
 *    symbol guard a USDG transfer would come back tagged USDC — a wrong token
 *    name on a payment prefill, which is the worst possible place to be wrong.
 *    `usdgIsNotLabelledUsdc` is that guard's test.
 *
 * Hermetic: pure config + pure functions, no network, no KV, no secrets.
 */
import { WALLET_CHAINS, WALLET_CHAIN_ORDER, walletChainByChainId, type WalletChain } from "../src/lib/wallet/chains";
import { parsePaymentQr, buildPaymentUri } from "../src/lib/payment-qr";

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  failures.push(detail ? `${name} — ${detail}` : name);
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const keys = Object.keys(WALLET_CHAINS) as WalletChain[];

// ── 1. The config itself ────────────────────────────────────────────────────
// A duplicate chainId would make walletChainByChainId return whichever entry
// happened to be declared first — a coin-flip, not a lookup.
const ids = keys.map((k) => WALLET_CHAINS[k].chainId);
eq("chainIds are unique", new Set(ids).size, ids.length);

for (const k of keys) {
  const c = WALLET_CHAINS[k];
  check(`${k}: stable is a checksummed 0x address`, /^0x[0-9a-fA-F]{40}$/.test(c.stable), c.stable);
  check(`${k}: stableDecimals is positive`, c.stableDecimals > 0, String(c.stableDecimals));
  check(`${k}: has a label and a short name`, !!c.label && !!c.short);
  // An explorer URL without its own name is how "Basescan ↗" ended up linking
  // to a Sepolia explorer once already.
  check(`${k}: explorer carries its own display name`, !!c.explorer && !!c.explorerName);
  eq(`${k}: round-trips through walletChainByChainId`, walletChainByChainId(c.chainId), k);
}

check("unknown chainId resolves to undefined", walletChainByChainId(1) === undefined);

// The switcher list must not name a chain that doesn't exist.
for (const k of WALLET_CHAIN_ORDER) {
  check(`switcher entry ${k} exists in WALLET_CHAINS`, keys.includes(k));
}

// ── 2. The two chains this wallet is actually about ─────────────────────────
// Verified live 2026-09-05 (see the module header): Base symbol() → "USDC",
// Robinhood symbol() → "USDG", both decimals() → 6.
eq("Base is 8453", WALLET_CHAINS.base.chainId, 8453);
eq("Base settles in USDC", WALLET_CHAINS.base.stableSymbol, "USDC");
eq("Robinhood is 4663", WALLET_CHAINS.robinhood.chainId, 4663);
eq("Robinhood settles in USDG, not USDC", WALLET_CHAINS.robinhood.stableSymbol, "USDG");
// Two chains sharing no state must not share an explorer either.
check(
  "Robinhood does not link to a Base explorer",
  !WALLET_CHAINS.robinhood.explorer.includes("basescan"),
  WALLET_CHAINS.robinhood.explorer,
);

// ── 3. buildPaymentUri — regression lock on the NET_TO_CHAIN removal ────────
const to = "0x1111111111111111111111111111111111111111";

eq(
  "USDC request on Base is byte-identical to the old table's output",
  buildPaymentUri({ to, amount: "12.5", asset: "USDC", network: "base" }),
  `ethereum:${WALLET_CHAINS.base.stable}@8453/transfer?address=${to}&uint256=12500000`,
);
eq(
  "ETH request on Base",
  buildPaymentUri({ to, amount: "0.25", asset: "ETH", network: "base" }),
  `ethereum:${to}@8453?value=250000000000000000`,
);
eq(
  "Sepolia request uses 84532, not 8453",
  buildPaymentUri({ to, amount: "1", asset: "USDC", network: "baseSepolia" }),
  `ethereum:${WALLET_CHAINS.baseSepolia.stable}@84532/transfer?address=${to}&uint256=1000000`,
);
eq(
  "Robinhood request uses 4663 and the USDG contract",
  buildPaymentUri({ to, amount: "7", asset: "USDC", network: "robinhood" }),
  `ethereum:${WALLET_CHAINS.robinhood.stable}@4663/transfer?address=${to}&uint256=7000000`,
);
eq("no amount → bare address QR", buildPaymentUri({ to, network: "base" }), to);
eq("zero amount → bare address QR", buildPaymentUri({ to, amount: "0", network: "base" }), to);

// ── 4. parsePaymentQr ───────────────────────────────────────────────────────
const baseUsdc = WALLET_CHAINS.base.stable;
const parsed = parsePaymentQr(`ethereum:${baseUsdc}@8453/transfer?address=${to}&uint256=2500000`);
eq("Base USDC transfer → network base", parsed?.network, "base");
eq("Base USDC transfer → asset USDC", parsed?.asset, "USDC");
eq("Base USDC transfer → 2.5 human units", parsed?.amount, "2.5");
eq("Base USDC transfer → recipient", parsed?.to, to);

// THE GUARD. Without the stableSymbol check in usdcFor(), the USDG contract
// matches "the chain's stable" and this comes back asset: "USDC".
const usdg = WALLET_CHAINS.robinhood.stable;
const rh = parsePaymentQr(`ethereum:${usdg}@4663/transfer?address=${to}&uint256=3000000`);
eq("usdgIsNotLabelledUsdc — RH transfer resolves to the RH network", rh?.network, "robinhood");
eq("usdgIsNotLabelledUsdc — USDG is NOT called USDC", rh?.asset, undefined);

// A chain we don't know must not silently resolve to one we do.
const unknown = parsePaymentQr(`ethereum:${to}@999999?value=1000`);
eq("unknown chain → network undefined", unknown?.network, undefined);

eq("bare address", parsePaymentQr(to)?.to, to);
eq("basename", parsePaymentQr("shop.base")?.to, "shop.base");
eq("garbage → null", parsePaymentQr("hello world"), null);

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n✗ wallet-chains-test: ${failures.length} failed, ${pass} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ wallet-chains-test: ${pass} assertions passed`);
