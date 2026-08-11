// Robinhood Chain RWA Registry — canonical tokenized-stock / ETF address book.
//
// Two authoritative sources:
//   1. Token contracts:  docs.robinhood.com/chain/contracts/
//      + Blockscout-verified late listings (MSTR is on-chain but not on the
//      docs page at time of writing).
//   2. Chainlink price feeds: reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
//      — the source-of-truth JSON that docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood
//      is generated from.
//
// Both structs stay hand-curated: token contracts change so rarely (once per
// stock listing) that runtime fetch + KV cache is more failure surface than
// value. When Robinhood adds a stock, add a row here + open a PR.
//
// Every stock/ETF token is issued by Robinhood Assets (Jersey) Limited (RHJ).
// A token with a matching ticker but different contract is NOT a canonical
// Robinhood Stock Token — hub_rh_rwa_verify surfaces that mismatch as a warning.

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
  "0x0000000000000000000000000000000000000000" as `0x${string}`; // TODO: populate if RHJ publishes one

// ─── Tokens ────────────────────────────────────────────────────────────────
//
// Sources:
//   • docs.robinhood.com/chain/contracts (canonical 25 stocks + ETFs + USDG)
//   • Blockscout /token page for late listings (currently: MSTR)
//   • Chainlink feed JSON confirmed each ticker's live feed
//
// Fields:
//   • `contract`  — the RHJ stock/ETF token address
//   • `chainlinkFeed` — Chainlink AggregatorV3 proxy address, 8 decimals
//                       (empty string if no feed yet — feed will land later)

export const RWA_TOKENS: RwaToken[] = [
  // ── Stocks (US equities) ─────────────────────────────────────────────────
  { ticker: "AAPL",  name: "Apple Inc.",                 contract: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", chainlinkHeartbeat: 86400 },
  { ticker: "AMD",   name: "Advanced Micro Devices",     contract: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72", chainlinkHeartbeat: 86400 },
  { ticker: "AMZN",  name: "Amazon.com Inc.",            contract: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer", chainlinkFeed: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C", chainlinkHeartbeat: 86400 },
  { ticker: "BABA",  name: "Alibaba Group",              contract: "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer", chainlinkFeed: "0x62Cc8F9b5f56a33c9C8A60c8B92779f523c4E984", chainlinkHeartbeat: 86400 },
  { ticker: "BE",    name: "Bloom Energy",               contract: "0x822CC93fFD030293E9842c30BBD678F530701867", decimals: 18, kind: "stock", issuer: "RHJ", sector: "energy",   note: "No Chainlink feed listed at time of registry snapshot." },
  { ticker: "COIN",  name: "Coinbase Global",            contract: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", decimals: 18, kind: "stock", issuer: "RHJ", sector: "finance",  chainlinkFeed: "0xA3a468A452940B7D6b69991207B508c609a98Ef2", chainlinkHeartbeat: 86400 },
  { ticker: "CRCL",  name: "Circle Internet Group",      contract: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", decimals: 18, kind: "stock", issuer: "RHJ", sector: "finance",  chainlinkFeed: "0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a", chainlinkHeartbeat: 86400 },
  { ticker: "CRWV",  name: "CoreWeave Inc.",             contract: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0xe1b3aABCAFAd1c94708dc1367dcfF8Aa4407487C", chainlinkHeartbeat: 86400 },
  { ticker: "GOOGL", name: "Alphabet Inc.",              contract: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0xF6f373a037c30F0e5010d854385cA89185AE638b", chainlinkHeartbeat: 86400 },
  { ticker: "INTC",  name: "Intel Corporation",          contract: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0x3f390C5C24628Ac7C489515402235FeAD71D1913", chainlinkHeartbeat: 86400 },
  { ticker: "META",  name: "Meta Platforms",             contract: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0x7C38C00C30BEe9378381E7B6135d7283356D71b1", chainlinkHeartbeat: 86400 },
  { ticker: "MSFT",  name: "Microsoft Corporation",      contract: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E", chainlinkHeartbeat: 86400 },
  { ticker: "MSTR",  name: "Strategy Inc.",              contract: "0xec262a75e413fAfD0dF80480274532C79D42da09", decimals: 18, kind: "stock", issuer: "RHJ", sector: "finance",  chainlinkFeed: "0x396118bdFB181e6240E74D243F266B061c0edc3D", chainlinkHeartbeat: 86400, note: "Late listing — Blockscout-verified. Formerly MicroStrategy." },
  { ticker: "MU",    name: "Micron Technology",          contract: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0x425EEFdCf05ed6526C3cE61Af99429A228a6d596", chainlinkHeartbeat: 86400 },
  { ticker: "NVDA",  name: "NVIDIA Corporation",         contract: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", chainlinkHeartbeat: 86400 },
  { ticker: "ORCL",  name: "Oracle Corporation",         contract: "0xb0992820E760d836549ba69BC7598b4af75dEE03", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844", chainlinkHeartbeat: 86400 },
  { ticker: "PLTR",  name: "Palantir Technologies",      contract: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c", chainlinkHeartbeat: 86400 },
  { ticker: "SNDK",  name: "SanDisk Corporation",        contract: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", decimals: 18, kind: "stock", issuer: "RHJ", sector: "tech",     chainlinkFeed: "0xfb133Fa4B7b385802B693a293606682Df47109A3", chainlinkHeartbeat: 86400 },
  { ticker: "SPCX",  name: "SPCX Ventures",              contract: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", decimals: 18, kind: "stock", issuer: "RHJ", sector: "space",    chainlinkFeed: "0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb", chainlinkHeartbeat: 86400 },
  { ticker: "TSLA",  name: "Tesla Inc.",                 contract: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18, kind: "stock", issuer: "RHJ", sector: "consumer", chainlinkFeed: "0x4A1166a659A55625345e9515b32adECea5547C38", chainlinkHeartbeat: 86400 },
  { ticker: "USAR",  name: "USA Rare Earth",             contract: "0xd917B029C761D264c6A312BBbcDA868658eF86a6", decimals: 18, kind: "stock", issuer: "RHJ", sector: "materials",chainlinkFeed: "0xA994d3684e8400A6c8078226925779FdeE682DD9", chainlinkHeartbeat: 86400 },
  // ── ETFs ────────────────────────────────────────────────────────────────
  { ticker: "QQQ",   name: "Invesco QQQ Trust",          contract: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-tech",    chainlinkFeed: "0x80901d846d5D7B030F26B480776EE3b29374C2ae", chainlinkHeartbeat: 86400 },
  { ticker: "SGOV",  name: "iShares 0-3 Month Treasury", contract: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-bond",    chainlinkFeed: "0xa0DF4ee0fFf975306345875E3548Fcc519577A11", chainlinkHeartbeat: 86400 },
  { ticker: "SLV",   name: "iShares Silver Trust",       contract: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-metals",  chainlinkFeed: "0x209b73908e92Ae021826eD79609845451Ecba2ce", chainlinkHeartbeat: 86400 },
  { ticker: "SPY",   name: "SPDR S&P 500 ETF",           contract: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-index",   chainlinkFeed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", chainlinkHeartbeat: 86400 },
  { ticker: "CUSO",  name: "CUSO ETF",                   contract: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", decimals: 18, kind: "etf", issuer: "RHJ", sector: "etf-index",   note: "No Chainlink feed listed at time of registry snapshot." },
  // ── Utility / wrapped ────────────────────────────────────────────────────
  { ticker: "WETH",  name: "Wrapped Ether",              contract: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18, kind: "wrapped", issuer: "other" },
  { ticker: "USDG",  name: "Global Dollar (USDG)",       contract: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals:  6, kind: "stable",  issuer: "Global Dollar Network" },
];

// ─── Chainlink-only feeds ──────────────────────────────────────────────────
// Tickers with a live Chainlink feed on RH Chain but whose ERC-20 token
// contract isn't in our registry yet. Surfaced by hub_rh_stock_quote so callers
// can still get a live oracle price. When Robinhood publishes the token
// contract, promote the row into RWA_TOKENS.
export const CHAINLINK_ONLY_FEEDS: {
  ticker: string;
  name: string;
  chainlinkFeed: `0x${string}`;
  chainlinkHeartbeat: number;
}[] = [
  { ticker: "TSM",   name: "Taiwan Semiconductor",       chainlinkFeed: "0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F", chainlinkHeartbeat: 86400 },
  { ticker: "RGTI",  name: "Rigetti Computing",          chainlinkFeed: "0x2A045cF1C49c61c166C036d2f06FA2D2d984f765", chainlinkHeartbeat: 86400 },
  { ticker: "RKLB",  name: "Rocket Lab USA",             chainlinkFeed: "0x045477BF65Aef6f4F2386ad0164579e48381CC74", chainlinkHeartbeat: 86400 },
  { ticker: "IONQ",  name: "IonQ Inc.",                  chainlinkFeed: "0x22EfeC4919baf55F360E0EDee4AbEB26DE4971eb", chainlinkHeartbeat: 86400 },
  { ticker: "NBIS",  name: "Nebius Group",               chainlinkFeed: "0xE1D87B116Ba0fe898998f1D140339D1fA1E09705", chainlinkHeartbeat: 86400 },
  { ticker: "CLSK",  name: "CleanSpark Inc.",            chainlinkFeed: "0x810c12D3a554Bc47fd39597Fe3b3AAC4941F50eF", chainlinkHeartbeat: 86400 },
  { ticker: "ASML",  name: "ASML Holding",               chainlinkFeed: "0xB4106147E8cce40b7d46124090d373A71b70f87D", chainlinkHeartbeat: 86400 },
  { ticker: "USO",   name: "United States Oil Fund",     chainlinkFeed: "0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c", chainlinkHeartbeat: 86400 },
  { ticker: "GME",   name: "GameStop Corp.",             chainlinkFeed: "0x27C71df6A64fB476468EdF256CF72c038baB5B67", chainlinkHeartbeat: 86400 },
  { ticker: "EWY",   name: "iShares MSCI South Korea",   chainlinkFeed: "0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1", chainlinkHeartbeat: 86400 },
];

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
