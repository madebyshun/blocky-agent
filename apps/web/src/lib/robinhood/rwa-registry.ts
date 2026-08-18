// Robinhood Chain RWA Registry — canonical tokenized-stock / ETF address book.
//
// Two authoritative sources:
//   1. Token contracts: every `Deployed(bytes32 uid, address stock, string name,
//      string symbol)` event emitted by the RHJ factory at RH_RWA_DEPLOYER.
//      docs.robinhood.com/chain/contracts is a *subset* — it lags the chain.
//   2. Chainlink price feeds: reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
//      — the source-of-truth JSON that docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood
//      is generated from.
//
// ── Why this file is generated-then-committed, not hand-curated ─────────────
// It used to say "add a row here when Robinhood adds a stock", and that decayed
// exactly the way a manual list does: it held 26 rows while the chain held 203
// RHJ deployments. Everything downstream inherited the gap — ~30 rh-* tools
// resolve tickers through here, so real, deployer-verified stock tokens were
// invisible to all of them at once. Two of the misses were load-bearing: GME (a
// live token, thousands of buys) was listed under CHAINLINK_ONLY_FEEDS as "no
// contract yet" — while the only GME-named contract a searching user *would*
// find is an impersonator; and USO was filed under the ticker "CUSO" with a note
// claiming no feed, which made rh-rwa-verify raise a false scam alarm on a
// genuine canonical token.
//
// ── Why the factory log, and not the token list ────────────────────────────
// The first repair pass enumerated Blockscout `/api/v2/tokens?type=ERC-20` and
// kept the rows whose `creator_address_hash` matched the deployer. Sound logic,
// wrong index: `/tokens` is sorted by market cap and serves a fixed 50-row page
// (it accepts a `limit` param and ignores it — measured at 50/100/200). So that
// sweep could only see tokens that already had a market cap, and it "completed"
// at 96 rows while missing 107 real ones. A genuine RHJ deployment with no pool
// yet — exactly the new-listing case this registry exists to catch — sorts last
// and stays invisible. The 26→96 fix reproduced the original bug one layer down.
//
// A `Deployed` event cannot be ranked out of a list, needs no per-token creator
// lookup, and is impersonation-proof by construction: a contract cannot emit
// another contract's events, so membership here *is* the provenance proof that
// `creator == RH_RWA_DEPLOYER` was approximating. The fake GME (0x1c8a973a…,
// 2,362 holders) came out of thirdweb's TWCloneFactory and can never appear.
//
// So the rows below are produced by `npx tsx scripts/rwa-generate.ts --write`,
// then committed (a runtime fetch would put Blockscout in the request path of
// every quote — 2.4–8.8s per address call, measured). Keeping them honest is
// `npm run rwa:verify`, which re-runs the crawl read-only and exits non-zero on
// drift. Hand-edit only the display `name` / `sector` / `note` columns — the
// generator preserves those and regenerates everything else; never hand-add an
// address.
//
// Every stock/ETF token is issued by Robinhood Assets (Jersey) Limited (RHJ).
// Ticker, name and decimals are strings anyone can copy — the deployer is not.
// hub_rh_rwa_verify leads with provenance for that reason.

export type RwaKind = "stock" | "etf" | "stable" | "wrapped";

export type RwaToken = {
  ticker: string;               // "MSTR"
  name: string;                 // "Strategy Inc."
  contract: `0x${string}`;      // on-chain address, checksummed
  decimals: number;             // 18 for stocks/ETFs; per-token for stables
  kind: RwaKind;
  issuer: "RHJ" | "Circle" | "Global Dollar Network" | "other";
  underlying?: string;          // real-world equity ticker (usually = ticker)
  sector?: string;              // "tech" | "consumer" | "energy" | "finance" | "etf" | ...
  chainlinkFeed?: `0x${string}`;// Chainlink /USD proxy on RH Chain (8 decimals)
  chainlinkHeartbeat?: number;  // seconds — 86400 for RH stock feeds
  note?: string;
};

// Chain metadata (kept here so the tool JSON always self-describes).
export const RH_CHAIN = {
  chainId: 4663,
  name: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
} as const;

// Chainlink feeds for the two native-side base assets — used by the swap
// tools to convert WETH-denom amounts to USD without pinging GT for it.
export const RH_CHAINLINK_ETH_USD =
  "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" as `0x${string}`;
export const RH_CHAINLINK_USDG_USD =
  "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2" as `0x${string}`;

/**
 * The RHJ token factory — an `ERC1967Proxy`, not an EOA. Every canonical
 * stock/ETF token on RH Chain is born from a `deploy` call on it, and is also
 * reported as that token's `creator_address_hash`.
 *
 * This is the registry's one *provable* claim. Ticker and name are strings an
 * impersonator copies for free — the fake GME on this chain carries the exact
 * byte-for-byte name "GameStop • Robinhood Token" — but the contract that
 * created a contract is fixed at deployment and cannot be forged after the
 * fact. So provenance is the check that actually separates a real Robinhood
 * stock token from a copy, and `rh-rwa-verify` leads with it.
 *
 * Every RHJ row below was read out of this factory's own `Deployed` events —
 * that is the crawl's source, not a property checked afterwards (203/203 by
 * construction). `rh-rwa-verify` re-derives the same set independently through
 * `/api/v2/addresses/{token}` → creator_address_hash, so the two agree only if
 * both are right. WETH and USDG correctly do NOT match — different issuers, by
 * design, and `rh-rwa-verify` is expected to say so.
 */
export const RH_RWA_DEPLOYER =
  "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046" as `0x${string}`;

// ─── Tokens ────────────────────────────────────────────────────────────────
//
// 203 RHJ deployments (181 stocks + 22 ETFs) + 2 utility rows.
// 35 carry a Chainlink feed — that is every equity feed RH Chain publishes,
// so a row without `chainlinkFeed` means the oracle doesn't exist yet, not
// that we failed to look it up. Most rows therefore cannot be price-quoted or
// polled; being in this address book means "provably issued by RHJ", which is
// not the same as "liquid" or "tradable". Liquidity is a separate question
// each rh-* tool answers from DEX data at call time.
//
// Fields:
//   • `contract`      — the RHJ stock/ETF token address (checksummed via viem)
//   • `name`          — the factory's `Deployed` event name minus the
//                       " • Robinhood Token" suffix, except where a
//                       hand-written display name reads better
//   • `kind`          — "etf" when the on-chain name says ETF/Trust/Fund. That
//                       is a display heuristic on the only signal the chain
//                       gives; a miscategorised fund is never a wrong address.
//   • `sector`        — hand-written, and absent on most rows. Deliberately
//                       NOT inferred: a guessed sector is a fabricated fact,
//                       and several rh-* tools group by this key.
//   • `chainlinkFeed` — Chainlink AggregatorV3 proxy, 8 decimals; omitted (not
//                       empty-string) when the ticker has no feed

export const RWA_TOKENS: RwaToken[] = [
  // ── Stocks (US equities) ─────────────────────────────────────────────────
  { ticker: "AAOI",  name: "Applied Optoelectronics",                     contract: "0x521Cf887E6531c6F667b5BC4D896E5d9bfE8EB2E", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "AAPL",  name: "Apple Inc.",                                  contract: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", chainlinkHeartbeat: 86400 },
  { ticker: "ABCL",  name: "Abcellera Biologics",                         contract: "0x3139D77Ace0cbAA5bDfD38bD1F1911a794AF0B0e", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "ADBE",  name: "Adobe",                                       contract: "0x232B8ed6377BE97813853B0Ac104c4Cda8378d1B", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "AEHR",  name: "Aehr",                                        contract: "0x5F604fBA1162193A4388A5DFa56F556f3E133cC2", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "AEIS",  name: "Advanced Energy",                             contract: "0xfAf9cb261B5FCC1f404Bb10CD39C5c6C1974E612", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "ALAB",  name: "Astera Labs, Inc.",                           contract: "0x748c32c3ca24eDf31ea597Db1F3d330a7a6DA3Dc", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "AMAT",  name: "Applied Materials",                           contract: "0x36046893810a7E7fCE501229d57dc3FC8c8716d0", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "AMBA",  name: "Ambarella",                                   contract: "0x99D9D8663545151603863C5AcbD6FC3218899009", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "AMC",   name: "AMC Entertainment",                           contract: "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "AMD",   name: "Advanced Micro Devices",                      contract: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72", chainlinkHeartbeat: 86400 },
  { ticker: "AMKR",  name: "Amkor Technology",                            contract: "0xDd356AA38F40A7b7076755aC854B6FBb1F0D305B", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "AMZN",  name: "Amazon.com Inc.",                             contract: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer", chainlinkFeed: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C", chainlinkHeartbeat: 86400 },
  { ticker: "ANET",  name: "Arista",                                      contract: "0x28bABD556b60E53663B8615036479a29c2CDd1Bf", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "APLD",  name: "Applied Digital",                             contract: "0xb8DBf92F9741c9ac1c32115E78581f23509916FD", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "APP",   name: "AppLovin",                                    contract: "0xA249BAF1063Af884807C1E1400AEf7784836917E", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "ARM",   name: "Arm Holdings plc",                            contract: "0x666716999E75d2652398FF830Bbc2e485946E140", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "ASML",  name: "ASML Holding NV",                             contract: "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0xB4106147E8cce40b7d46124090d373A71b70f87D", chainlinkHeartbeat: 86400 },
  { ticker: "ASTS",  name: "AST SpaceMobile",                             contract: "0x1AF6446f07eb1d97c546AFC8c9544cBDF3AD5137", decimals: 18, kind: "stock", issuer: "RHJ", sector: "space" },
  { ticker: "AUR",   name: "Aurora Innovation",                           contract: "0x373C06c4f7BDe527D7Dae4BA169E42b55E393CeD", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "AVAV",  name: "AeroVironment",                               contract: "0xF6290b5e7C26502e2dA514C31509849718EA76A5", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "AVGO",  name: "Broadcom",                                    contract: "0x156E175DD063a8cE274C50654eF40e0032b3fbcF", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "AXON",  name: "Axon",                                        contract: "0xC27dBD474aF5181c5A8777903690D8D262D12648", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "AXTI",  name: "AXT",                                         contract: "0x141eEa040c2250eEc0314e336975e81f85f6585e", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "BA",    name: "Boeing",                                      contract: "0x4D21483a44Bf67a86b77E3dA301411880797D452", decimals: 18, kind: "stock", issuer: "RHJ", sector: "industrials" },
  { ticker: "BABA",  name: "Alibaba Group",                               contract: "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer", chainlinkFeed: "0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984", chainlinkHeartbeat: 86400 },
  { ticker: "BB",    name: "Blackberry",                                  contract: "0x48E39E56aCdbA37b09020C0b734A613C9a2f100A", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "BE",    name: "Bloom Energy",                                contract: "0x822CC93fFD030293E9842c30BBD678F530701867", decimals: 18, kind: "stock", issuer: "RHJ", sector: "energy", note: "No Chainlink feed on RH Chain at time of registry snapshot." },
  { ticker: "BULL",  name: "Webull",                                      contract: "0xceF9027c7d6985b85f0BA431125073529A947A68", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "CBRS",  name: "Cerebras Systems",                            contract: "0x5c90450Bbb4273D7b2f17CF6917AEB237A569679", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "CCL",   name: "Carnival Corporation",                        contract: "0x9651342CeA770aE9a2969Ba2A52611523146aef9", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "CEG",   name: "Constellation Energy",                        contract: "0xaE517A2903E68bd929Dfd15be875F8369D53e94a", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "CELH",  name: "Celsius",                                     contract: "0x8cF07C5A878945185d327aAa6e33FAa95F95e7bF", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "CIEN",  name: "Ciena",                                       contract: "0x44f6D488021f8233B9416294d1FE9b1fEe28382d", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "CLOV",  name: "Clover Health Investments",                   contract: "0x62200915e7DEab1eC7f79fb246daDbB80eACdDd0", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "CLS",   name: "Celestica",                                   contract: "0xBf449977089c718C004a66C554B26B94ef3Ad4De", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "CLSK",  name: "CleanSpark",                                  contract: "0xcBB95BBF36099d34dA091dc6Fa6F49EfA257Cee3", decimals: 18, kind: "stock", issuer: "RHJ", sector: "crypto", chainlinkFeed: "0x810c12D3a554Bc47fd39597Fe3b3AAC4941F50eF", chainlinkHeartbeat: 86400 },
  { ticker: "COHR",  name: "Coherent",                                    contract: "0x92F9F459F1a9a5AD266b182BE7Bffd1C6c666894", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "COIN",  name: "Coinbase Global",                             contract: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", decimals: 18, kind: "stock", issuer: "RHJ", sector: "finance", chainlinkFeed: "0xA3a468A452940B7D6b69991207B508c609a98Ef2", chainlinkHeartbeat: 86400 },
  { ticker: "COST",  name: "Costco",                                      contract: "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "CRCL",  name: "Circle Internet Group",                       contract: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", decimals: 18, kind: "stock", issuer: "RHJ", sector: "finance", chainlinkFeed: "0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a", chainlinkHeartbeat: 86400 },
  { ticker: "CRDO",  name: "Credo Technology Group",                      contract: "0x4D67253bc223e6b0e104F1084c1fb2b669dDC41b", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "CRM",   name: "Salesforce",                                  contract: "0xd95B44124e475743a7589e68F3D74008A5536D44", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "CRWD",  name: "CrowdStrike Holdings",                        contract: "0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "CRWV",  name: "CoreWeave Inc.",                              contract: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0xe1b3aABCAFAd1c94708dc1367dcfF8Aa4407487C", chainlinkHeartbeat: 86400 },
  { ticker: "CSCO",  name: "Cisco Systems",                               contract: "0xF543967EEBB6f1917992eF0E68De63ab07a5a0dA", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "CTSH",  name: "Cognizant",                                   contract: "0x63D5a3b6939a33f1e75d8Bcd85759858239600DB", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "CVNA",  name: "Carvana",                                     contract: "0xa4f319104089FE321dc8093C6E707d4fE190A988", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "DDOG",  name: "Datadog",                                     contract: "0x27c99fBde9D0d2AA4f4Bfb4943f237843DdF6958", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "DELL",  name: "Dell",                                        contract: "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x1C6c8cADBe02E19129c39dDB92281cE4c0bf206b", chainlinkHeartbeat: 86400 },
  { ticker: "DJT",   name: "Trump Media & Technology Group Corp.",        contract: "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "DOCN",  name: "DigitalOcean",                                contract: "0xc02f12B9fe9E707079EC0d546f3050d3F6C1F8bD", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "ELF",   name: "e.l.f. Beauty",                               contract: "0x39EC44Bee4F6A116c6F9B8De566848a985C53C60", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "F",     name: "Ford Motor",                                  contract: "0x25C288E6D899b9BC30160965aD9644c67e73bE0C", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "FICO",  name: "Fair Isaac",                                  contract: "0xa48F22A46C0F1C46CA7D111CB6c137c271987180", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "FIG",   name: "Figma",                                       contract: "0x41F4267525a8AFf329540eF24fD83d9044758B33", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "FISV",  name: "Fiserv",                                      contract: "0x9ECe29A4A2397C0a35fb5fA8EE2b9509130a98cc", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "FIX",   name: "Comfort Systems",                             contract: "0x93Dbb1d2Dc5D63F4abACFF30485273f538Df68Ac", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "FLNC",  name: "Fluence Energy",                              contract: "0x282e87451E10fA6679BC7D76C69BE44cD3fC777C", decimals: 18, kind: "stock", issuer: "RHJ", sector: "energy" },
  { ticker: "FLY",   name: "Firefly Aerospace Inc.",                      contract: "0x03BC731Ffb162cdd7B98D3C6542bFC291126075d", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "FTNT",  name: "Fortinet",                                    contract: "0x3FB8976980d486084b2eb4a404BD12e72823958f", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "FUTU",  name: "Futu Holdings",                               contract: "0xeB30663bDFf0622Ef4e4E5cBb4E975F19f33f51D", decimals: 18, kind: "stock", issuer: "RHJ", sector: "finance" },
  { ticker: "GE",    name: "General Electric",                            contract: "0x63b814DDBd6BF339f25Fed8c36158a008D5B373e", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "GEV",   name: "GE Vernova",                                  contract: "0x94B8AAE43A1cCc08Aa64B7D1F29b4D920aF4a0C9", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "GLW",   name: "Corning",                                     contract: "0x7c04E6A3368F2A1DE3874f0e80d2e0A1a9915da6", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "GLXY",  name: "Galaxy Digital Inc.",                         contract: "0x2D427692E928fa156ec22acfaBaFA0447C5805B7", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "GME",   name: "GameStop",                                    contract: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer", chainlinkFeed: "0x27C71df6A64fB476468EdF256CF72c038baB5B67", chainlinkHeartbeat: 86400 },
  { ticker: "GOOGL", name: "Alphabet Inc.",                               contract: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0xF6f373a037c30F0e5010d854385cA89185AE638b", chainlinkHeartbeat: 86400 },
  { ticker: "HII",   name: "Huntington Ingalls",                          contract: "0xEB61c0Ed490A367d4E3631cCf8a74B3bfc7E775D", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "HIMS",  name: "Hims & Hers Health",                          contract: "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "HPE",   name: "HP Enterprise",                               contract: "0x59dd09d4900C2E4B5F75b7c0d4E6796fcc234Cb1", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "HWM",   name: "Howmet Aerospace",                            contract: "0xAEa445c5F3DB1a462998ccC422A875A361ee5d99", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "IBM",   name: "IBM",                                         contract: "0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "IBRX",  name: "ImmunityBio,",                                contract: "0x7c148F74ac7445D1F28366b7FcDC6792a9Fcd0Cf", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "INFQ",  name: "Infleqtion",                                  contract: "0xB853bC83a753342a4f8320ea680b4B1E84118D21", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "INOD",  name: "Innodata",                                    contract: "0xf1953DAB6FaD537488d5A022361FfAa8B4c95eC6", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "INTC",  name: "Intel Corporation",                           contract: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x3f390C5C24628Ac7C489515402235FeAD71D1913", chainlinkHeartbeat: 86400 },
  { ticker: "INTU",  name: "Intuit",                                      contract: "0x56d23beE5f41A7120170b0c603Dae30128e460e9", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "IONQ",  name: "IonQ",                                        contract: "0x558378E000D634A36593E338eBacdd6207640EfE", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x22EfeC4919baf55F360E0EDee4AbEB26DE4971eb", chainlinkHeartbeat: 86400 },
  { ticker: "IREN",  name: "IREN Limited",                                contract: "0xF0AB0c93bE6F41369d302e55db1A96b3c430212D", decimals: 18, kind: "stock", issuer: "RHJ", sector: "crypto" },
  { ticker: "JBL",   name: "Jabil Inc.",                                  contract: "0xEAf2512dFC1bEAc608F8794B3793CD4E02894Aa6", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "JNJ",   name: "Johnson & Johnson",                           contract: "0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "JOBY",  name: "Joby Aviation",                               contract: "0xb334C5cE741B80B5B671F47F5C269Cb193fe8E24", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "KLAC",  name: "KLA",                                         contract: "0x96b933C74eCB4A0926b9210cef7b743EF46be2E9", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "KSS",   name: "Kohls Corporation",                           contract: "0x12e3c047bf9AeCAF9dDC98c05C31BFD1dd043993", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "KTOS",  name: "Kratos Defense & Security Solutions",         contract: "0x7FD06a4d81cCfA3F351394E144d5191874C31313", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "LHX",   name: "L3Harris",                                    contract: "0x48d60243c66437c6ac3c2495Be94747aEd5Dfe25", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "LITE",  name: "Lumentum",                                    contract: "0x8eF20885F94e3D9bc7eB3080279188Bd5ED7c08C", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "LLY",   name: "Eli Lilly",                                   contract: "0x8005d266423c7ea827372c9c864491e5786600ea", decimals: 18, kind: "stock", issuer: "RHJ", sector: "healthcare" },
  { ticker: "LMT",   name: "Lockheed",                                    contract: "0x329fcACEb9AD6F9580DD5F643fed0646900D043c", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "LRCX",  name: "Lam Research Corp",                           contract: "0x57b0030166DB0C31690d1A5aA167e2e26e2C29a4", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "LULU",  name: "Lululemon",                                   contract: "0x4e62068525Ab11FE768e29dfD00ef909B9803016", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "LUNR",  name: "Intuitive Machines",                          contract: "0xa5D4968421bA94814Be3B136b15cf422101aC1a3", decimals: 18, kind: "stock", issuer: "RHJ", sector: "space" },
  { ticker: "MDB",   name: "MongoDB",                                     contract: "0xDdf2266b79abf0B48898959B0ed6E6adf512be74", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "META",  name: "Meta Platforms",                              contract: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x7C38C00C30BEe9378381E7B6135d7283356D71b1", chainlinkHeartbeat: 86400 },
  { ticker: "MOD",   name: "Modine",                                      contract: "0xc6Cbad1016b38B797610c25E1dc7D95988B1f362", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "MPWR",  name: "Monolithic Power Systems",                    contract: "0x52D50D0280AD1054b43f052bD70a49a212A1b128", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "MRNA",  name: "Moderna",                                     contract: "0x43B07D15cE533bEc5476d70C22a78a1B2B662155", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "MRVL",  name: "Marvell Technology",                          contract: "0x62fd0668e10D8B72339BE2DCF7643001688ff13B", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "MSFT",  name: "Microsoft Corporation",                       contract: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E", chainlinkHeartbeat: 86400 },
  { ticker: "MSTR",  name: "Strategy Inc.",                               contract: "0xec262a75e413fAfD0dF80480274532C79D42da09", decimals: 18, kind: "stock", issuer: "RHJ", sector: "finance", chainlinkFeed: "0x396118bdFB181e6240E74D243F266B061c0edc3D", chainlinkHeartbeat: 86400, note: "Late listing — Blockscout-verified. Formerly MicroStrategy." },
  { ticker: "MTSI",  name: "MACOM",                                       contract: "0xC93f4d80e268AB922e871bd169156C3CC41894e6", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "MU",    name: "Micron Technology",                           contract: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x425EEFdCf05ed6526C3cE61Af99429A228a6d596", chainlinkHeartbeat: 86400 },
  { ticker: "MXL",   name: "MaxLinear",                                   contract: "0x48961813349333209994750ffA89b3c5C22eC969", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "NAVN",  name: "Navan",                                       contract: "0xf7181b63Fdb858558A74ba96BC42732684cd7965", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "NBIS",  name: "Nebius Group",                                contract: "0x9D9c6684F596F66a64C030B93A886D51Fd4D7931", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0xE1D87B116Ba0fe898998f1D140339D1fA1E09705", chainlinkHeartbeat: 86400 },
  { ticker: "NET",   name: "Cloudflare",                                  contract: "0x116F00968269B7bfbaD4109cE591d6E74c0601d4", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "NFLX",  name: "Netflix",                                     contract: "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "NNE",   name: "Nano Nuclear Energy",                         contract: "0xBEF75684C43c4ea7BD18Dd532a2244674Ee8b926", decimals: 18, kind: "stock", issuer: "RHJ", sector: "energy" },
  { ticker: "NOK",   name: "Nokia",                                       contract: "0x25EE805ac369b6E3F8bF5764c682d34a37cb7175", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "NOW",   name: "ServiceNow",                                  contract: "0x0C3260aF4B8f13a69c4c2dFb84fD667890CDFa14", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "NU",    name: "Nu",                                          contract: "0x408c14038a04f7bD235329E26d2bf569ee20e250", decimals: 18, kind: "stock", issuer: "RHJ", sector: "finance" },
  { ticker: "NVDA",  name: "NVIDIA Corporation",                          contract: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", chainlinkHeartbeat: 86400 },
  { ticker: "NVTS",  name: "Navitas Semiconductor",                       contract: "0xbE6702d7b70315376dC48a3293f24f0982F86386", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "OKLO",  name: "Oklo",                                        contract: "0x8B2f88497f15A18E9D4FFa1a8fFB8538399aE774", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "ON",    name: "ON Semiconductor",                            contract: "0xbBD09F72b025360FeE5C928053Dca6248d35be54", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "ONTO",  name: "Onto Innovation",                             contract: "0x8ff63eAeEe3fE54Ba450c4F5538064Ec5A893Aef", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "ORCL",  name: "Oracle Corporation",                          contract: "0xb0992820E760d836549ba69BC7598b4af75dEE03", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844", chainlinkHeartbeat: 86400 },
  { ticker: "OUST",  name: "Ouster",                                      contract: "0x40E7a279850e443f582059ae5dC1c3b6563E6395", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "P",     name: "Everpure",                                    contract: "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D", decimals: 18, kind: "stock", issuer: "RHJ", sector: "industrials" },
  { ticker: "PANW",  name: "Palo Alto Networks",                          contract: "0xB039597eD45CBa7B6E2fb9E8BE51802969CEe5Be", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "PATH",  name: "UiPath",                                      contract: "0xfb2664f07B6Aadd29ea7a59D8859b1AeB8645cDa", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "PENG",  name: "Penguin Solutions",                           contract: "0x9b23573b156B52565012F5cE02CDF60AFBaa70Be", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "PFE",   name: "Pfizer",                                      contract: "0x7066A64c24e4206CD62E83bf198c1E7EB361F51e", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "PL",    name: "Planet Labs",                                 contract: "0xAA4d64474c172010aB57719cb9951E6142a100d3", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "PLTR",  name: "Palantir Technologies",                       contract: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c", chainlinkHeartbeat: 86400 },
  { ticker: "POET",  name: "POET Technologies",                           contract: "0xcf6B2D875361be807EAfa57458c80f28521F9333", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "POWL",  name: "Powell Industries",                           contract: "0x237c16D66590F67B886d978ACD362EAeaD8B18c7", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "PR",    name: "Permian Resources",                           contract: "0x4189F0c66EBBB0bfeF1C31f763131361EF32f77C", decimals: 18, kind: "stock", issuer: "RHJ", sector: "energy" },
  { ticker: "PWR",   name: "Quanta",                                      contract: "0x9Ab02Ead789b6903c3c44d0ED32F9c707CDF12FD", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "QBTS",  name: "D-Wave Quantum",                              contract: "0xC583c60aeF9Dc401Da72cEC1B404743a93cea1Cc", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "QCOM",  name: "Qualcomm",                                    contract: "0x0f17206447090e464C277571124dD2688E48AEA9", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "QNT",   name: "Quantinuum Inc. Class A",                     contract: "0xB7EDfE2F33C1aC06830a971dFb559bDe8A2a3d76", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "QUBT",  name: "Quantum Computing",                           contract: "0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "RBLX",  name: "Roblox",                                      contract: "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "RCAT",  name: "Red Cat",                                     contract: "0xFDE6b5d9BB419B10C23268c74e369AbFF39C0460", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "RDDT",  name: "Reddit",                                      contract: "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "RDW",   name: "Redwire",                                     contract: "0x92Ef19E82bD8fF36661DE838D5eaE7e5CEF0EfFE", decimals: 18, kind: "stock", issuer: "RHJ", sector: "space" },
  { ticker: "RGTI",  name: "Rigetti Computing",                           contract: "0x284358abc07F9359f19f4b5b4aC91901Be2597Ba", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x2A045cF1C49c61c166C036d2f06FA2D2d984f765", chainlinkHeartbeat: 86400 },
  { ticker: "RIVN",  name: "Rivian Automotive",                           contract: "0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "RKLB",  name: "Rocket Lab Corporation",                      contract: "0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2", decimals: 18, kind: "stock", issuer: "RHJ", sector: "space", chainlinkFeed: "0x045477BF65Aef6f4F2386ad0164579e48381CC74", chainlinkHeartbeat: 86400 },
  { ticker: "RUN",   name: "Sunrun",                                      contract: "0x756Bc80af765C82da966a788858d65aDF14f3793", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "SATS",  name: "EchoStar",                                    contract: "0x95052ddcd5DC25641657424A8Cf04834997E1730", decimals: 18, kind: "stock", issuer: "RHJ", sector: "space" },
  { ticker: "SHOP",  name: "Shopify",                                     contract: "0xF53F66751B1Eff985311b693531E3290F600c410", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "SIMO",  name: "Silicon Motion",                              contract: "0x77E655E37F4d913fB9540e0d541D824171a60e81", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "SKHY",  name: "SK hynix Inc. American Depositary Shares",    contract: "0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "SLS",   name: "SELLAS Life Sciences",                        contract: "0x285b231728c7E4333799183DF1094d775246a535", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "SMCI",  name: "Super Micro Computer",                        contract: "0xc01aA1fECeC0605b13bc84874ff7256C0f5F562a", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "SMR",   name: "NuScale Power",                               contract: "0x1Eebee7F74517e0279dFb09d25B0407bEEc3FDd6", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "SNAP",  name: "Snap",                                        contract: "0xF6589F11Bc40b669e584073F428B05562F568733", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "SNDK",  name: "SanDisk Corporation",                         contract: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0xfb133Fa4B7b385802B693a293606682Df47109A3", chainlinkHeartbeat: 86400 },
  { ticker: "SNOW",  name: "Snowflake",                                   contract: "0xBa0CAB75495255d0cB58E22B648bFED4ECD1F47E", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "SOFI",  name: "SoFi Technologies",                           contract: "0x98E75885157C80992A8D41b696D8c9C6Fb30A926", decimals: 18, kind: "stock", issuer: "RHJ", sector: "finance" },
  { ticker: "SOUN",  name: "SoundHound AI",                               contract: "0x6E3Dfd9f7e1649BaA14D25cac18C94d62dB10A54", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "SPCX",  name: "Space Exploration Technologies Corp",         contract: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", decimals: 18, kind: "stock", issuer: "RHJ", sector: "space", chainlinkFeed: "0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb", chainlinkHeartbeat: 86400 },
  { ticker: "TE",    name: "T1 Energy",                                   contract: "0xb1969f6604CA1AE7a2cD3F1827876e914594CA2D", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "TEAM",  name: "Atlassian Corporation",                       contract: "0x5B97476b922F3305131B8f0B9D333172E87f4aaE", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "TEM",   name: "Tempus AI",                                   contract: "0xB1CC0EC7Db69Cf43539119814df40071b9d61793", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "TER",   name: "Teradyne",                                    contract: "0x2778C5024D5cA2CdB0f8eAD671ffc69963AdCD9C", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "TSEM",  name: "Tower Semiconductor",                         contract: "0x89776d4Cd68193597A2fC132cfaC1fDe36CCeA8a", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "TSLA",  name: "Tesla Inc.",                                  contract: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer", chainlinkFeed: "0x4A1166a659A55625345e9515b32adECea5547C38", chainlinkHeartbeat: 86400 },
  { ticker: "TSM",   name: "Taiwan Semiconductor Manufacturing",          contract: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech", chainlinkFeed: "0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F", chainlinkHeartbeat: 86400 },
  { ticker: "TTD",   name: "Trade Desk",                                  contract: "0x0b5fb4031cae9163db10B169Ee72685F0EdC8545", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "TTWO",  name: "Take-Two Interactive Software",               contract: "0x5e81213613b6B86EaB4c6c50d718d34359459786", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer" },
  { ticker: "UMC",   name: "United Microelectronics",                     contract: "0x0E6e67Ba88e7b5d9B67636A215c76779B948dE79", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "UNH",   name: "UnitedHealth",                                contract: "0xcF364ea52787e289De6F32077834056E3E70D6A8", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "UPS",   name: "UPS",                                         contract: "0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2", decimals: 18, kind: "stock", issuer: "RHJ", sector: "industrials" },
  { ticker: "USAR",  name: "USA Rare Earth",                              contract: "0xd917B029C761D264c6A312BBbcDA868658eF86a6", decimals: 18, kind: "stock", issuer: "RHJ", sector: "materials", chainlinkFeed: "0xA994d3684e8400A6c8078226925779FdeE682DD9", chainlinkHeartbeat: 86400 },
  { ticker: "VICR",  name: "Vicor",                                       contract: "0x6006ed4B2F94110851ff7509D97D034f0EeD9226", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "VRT",   name: "Vertiv",                                      contract: "0xFA78C12E6488814A0262E4e802749a4a737d5fB7", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "VSAT",  name: "ViaSat",                                      contract: "0x26dCbfb34FC83CAbD6990f449674efDc6097fF85", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "VST",   name: "Vistra",                                      contract: "0x561e2a49212b7cCF47f2744Ccb83e200722fADBc", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "WDAY",  name: "Workday",                                     contract: "0x82DA4646242e1D962e96e932269Dc644c94a9CaA", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "WDC",   name: "Western Digital",                             contract: "0xF52597345A8Edf418bc4071b4a35112472277D3e", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "WULF",  name: "TeraWulf",                                    contract: "0x348Be1A8663f15edDe5CDf8A96BB69078f7aB6Fd", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "WYFI",  name: "WhiteFiber, Inc.",                            contract: "0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "XNDU",  name: "Xanadu Quantum",                              contract: "0xA8eB3BCcbf2017eE7CBfb652eB51CF2E1B153289", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "XOM",   name: "ExxonMobil Holdings Corporation",             contract: "0xf9B46d3D1B22199D4D1025a9cEDB540A33F1a2d5", decimals: 18, kind: "stock", issuer: "RHJ", sector: "energy" },
  { ticker: "ZETA",  name: "Zeta Global",                                 contract: "0xE674C5c071821f48BB2d12CAdb83617Eff438f9e", decimals: 18, kind: "stock", issuer: "RHJ" },
  { ticker: "ZM",    name: "Zoom",                                        contract: "0x44c4F142009036cF477eD2d09932051843137CF1", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },
  { ticker: "ZS",    name: "Zscaler",                                     contract: "0x7dc013eB55e436f30d7ED1AFE4E36d6e45e3c3f7", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech" },

  // ── ETFs ────────────────────────────────────────────────────────────────
  { ticker: "BND",   name: "Vanguard Total Bond Market ETF",              contract: "0x2F62fC9fAbb470C690f141c28340eD832bB27020", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "DRAM",  name: "Roundhill Memory ETF",                        contract: "0x33C18e2CC8AE9AE486e785090D86B2CE632FF994", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "EWT",   name: "iShares MSCI Taiwan Capped ETF",              contract: "0x1c690498150252222C275A5CEd69d3A6b1f52D5E", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "EWY",   name: "iShares MSCI South Korea fund",               contract: "0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-index", chainlinkFeed: "0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1", chainlinkHeartbeat: 86400 },
  { ticker: "GLD",   name: "SPDR Gold Trust",                             contract: "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "INDA",  name: "iShares MSCI India ETF",                      contract: "0xACEF2e09adb47aD6aBeBAD9fF06689E60615C2B6", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "JEPQ",  name: "J.P. Morgan Exchange-Traded Fund Trust JPMorgan Nasdaq Equity Premium Income ETF", contract: "0x565D3ff42D7d880287e5796B4c708632bE0cA098", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "NASA",  name: "Tema Space Innovators ETF",                   contract: "0x6ddb95405db6179012Bff2fFf7E0F8d49cF00137", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "QQQ",   name: "Invesco QQQ Trust",                           contract: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-tech", chainlinkFeed: "0x80901d846d5D7B030F26B480776EE3b29374C2ae", chainlinkHeartbeat: 86400 },
  { ticker: "RVI",   name: "Robinhood Ventures Fund I",                   contract: "0xb02e3E1b7f68559427C2D9100566E4F3CC5b7611", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "SCHD",  name: "Schwab US Dividend Equity ETF",               contract: "0xd63ABB2C13d7a8421a8017a712802053568e3C1D", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "SGOV",  name: "iShares 0-3 Month Treasury",                  contract: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-bond", chainlinkFeed: "0xa0DF4ee0fFf975306345875E3548Fcc519577A11", chainlinkHeartbeat: 86400 },
  { ticker: "SHY",   name: "iShares 1-3 Year Treasury Bond ETF",          contract: "0xBE274710Bf3d9567e1B290eF6a5F9f90ca016FD8", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "SLV",   name: "iShares Silver Trust",                        contract: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-metals", chainlinkFeed: "0x209b73908e92Ae021826eD79609845451Ecba2ce", chainlinkHeartbeat: 86400 },
  { ticker: "SMH",   name: "VanEck Semiconductor ETF",                    contract: "0x072f979c2CAc8e1391B0162a87Fee094bF8744a0", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "SOXX",  name: "iShares Semiconductor ETF",                   contract: "0x75742c18BC1f1C5c5f448f4C9D9C6F66dafAAa38", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-tech" },
  { ticker: "SPMO",  name: "Invesco S&P 500 Momentum ETF",                contract: "0xAd622320e520de39e72d41EF07438C3Fd3354875", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-index" },
  { ticker: "SPY",   name: "SPDR S&P 500 ETF",                            contract: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-index", chainlinkFeed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", chainlinkHeartbeat: 86400 },
  { ticker: "USO",   name: "United States Oil Fund",                      contract: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-energy", chainlinkFeed: "0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c", chainlinkHeartbeat: 86400, note: "Was mis-registered as ticker \"CUSO\" with no feed; on-chain symbol() is USO and the feed has been live all along." },
  { ticker: "VTI",   name: "Vanguard Total Stock Market ETF",             contract: "0x0594134DF3f171a354D9C85eBD65b7A6148F6D09", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "WEEK",  name: "Roundhill Weekly T-Bill ETF",                 contract: "0xc93a8c440CEa26D7445dF01729f193b27965099f", decimals: 18, kind: "etf", issuer: "RHJ" },
  { ticker: "XLK",   name: "State Street Technology Select Sector SPDR ETF", contract: "0x15Cd20759CE7F3285c29A319dE2D1A2e098c6f43", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-tech" },

  // ── Utility / wrapped (not factory output — different issuers, by design) ─
  { ticker: "WETH",  name: "Wrapped Ether",                               contract: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18, kind: "wrapped", issuer: "other" },
  { ticker: "USDG",  name: "Global Dollar (USDG)",                        contract: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, kind: "stable", issuer: "Global Dollar Network" },
];

// ─── Chainlink-only feeds ──────────────────────────────────────────────────
// Tickers with a live Chainlink feed on RH Chain but no ERC-20 token contract
// in RWA_TOKENS. Surfaced by hub_rh_stock_quote so callers still get a live
// oracle price for a ticker we can't hand them an address for.
//
// **Currently empty, and that is the correct state.** It used to hold 10 rows
// (TSM, RGTI, RKLB, IONQ, NBIS, CLSK, ASML, USO, GME, EWY) on the assumption
// that Robinhood hadn't published those token contracts yet. That was never
// true — every one of them was already deployed on chain by RH_RWA_DEPLOYER
// and simply absent from our hand-maintained list. The full deployer sweep
// promoted all 10 into RWA_TOKENS, so all 35 RH equity feeds now resolve to a
// real address. GME in particular was the tell: the registry claimed "no token
// contract", while the only GME-named contract a user would find by searching
// was an impersonator.
//
// Keep the array (the fallback path is legitimate — Chainlink can list a feed
// before RHJ deploys the token) but treat a non-empty value as a signal to
// re-run `npm run rwa:verify`, not as steady state.
export const CHAINLINK_ONLY_FEEDS: {
  ticker: string;
  name: string;
  chainlinkFeed: `0x${string}`;
  chainlinkHeartbeat: number;
}[] = [];

// ─── Indexes ───────────────────────────────────────────────────────────────

/** Fast lookup by upper-cased ticker. */
const BY_TICKER: Record<string, RwaToken> = Object.fromEntries(
  RWA_TOKENS.map((t) => [t.ticker.toUpperCase(), t]),
);

/** Fast lookup by lower-cased contract address. */
const BY_CONTRACT: Record<string, RwaToken> = Object.fromEntries(
  RWA_TOKENS.map((t) => [t.contract.toLowerCase(), t]),
);

export function findByTicker(tickerOrName: string): RwaToken | null {
  const raw = tickerOrName.trim();
  const q = raw.toUpperCase();
  if (BY_TICKER[q]) return BY_TICKER[q];
  // Exact name match (case-insensitive)
  const exactName = RWA_TOKENS.find((t) => t.name.toUpperCase() === q);
  if (exactName) return exactName;
  // Substring name match — only when query is ≥3 chars, to avoid over-matching
  // single-letter typos. "Tesla" matches "Tesla Inc.", "Apple" matches "Apple Inc.",
  // "Microsoft" matches "Microsoft Corporation".
  if (raw.length >= 3) {
    const contained = RWA_TOKENS.find((t) => t.name.toUpperCase().includes(q));
    if (contained) return contained;
  }
  return null;
}

export function findByContract(address: string): RwaToken | null {
  return BY_CONTRACT[address.trim().toLowerCase()] ?? null;
}

/** Chainlink-only ticker (no token contract yet). Returns feed row or null. */
export function findChainlinkOnly(ticker: string) {
  const q = ticker.trim().toUpperCase();
  return CHAINLINK_ONLY_FEEDS.find((f) => f.ticker === q) ?? null;
}

/** Full list of tickers we can quote (registry + chainlink-only). */
export function allQuotableTickers(): string[] {
  return [
    ...RWA_TOKENS.filter((t) => t.chainlinkFeed && (t.kind === "stock" || t.kind === "etf")).map((t) => t.ticker),
    ...CHAINLINK_ONLY_FEEDS.map((f) => f.ticker),
  ].sort();
}

/** Levenshtein distance — cheap fuzzy match for L3. */
export function levenshtein(a: string, b: string): number {
  const A = a.toUpperCase(), B = b.toUpperCase();
  if (A === B) return 0;
  const m = A.length, n = B.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const cur  = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

/** Rank tokens by fuzzy score vs query. Cheap + deterministic. */
export function fuzzySearch(query: string, limit = 5): { token: RwaToken; score: number }[] {
  const q = query.trim();
  if (!q) return [];
  return RWA_TOKENS
    .map((t) => {
      const dTicker = levenshtein(q, t.ticker);
      const dName   = levenshtein(q, t.name);
      // Prefix bonus — huge weight for tickers starting with query
      const prefixTicker = t.ticker.toUpperCase().startsWith(q.toUpperCase()) ? -10 : 0;
      const prefixName   = t.name.toUpperCase().includes(q.toUpperCase()) ? -3 : 0;
      const score = Math.min(dTicker, dName) + prefixTicker + prefixName;
      return { token: t, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
}
