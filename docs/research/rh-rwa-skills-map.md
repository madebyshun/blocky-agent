# RH RWA Skill Landscape — Blue Agent

**Context.** Vlad Tenev tweet (Jul 15 2026, `https://x.com/vladtenev/status/2077266840477479424`):

> If you're a builder looking to embed stock tokens or RWA into your applications, we want to hear from you.

Robinhood Chain (chainId 4663, Arbitrum Orbit L2) has **~26 tokenized US equities + ETFs** issued by **Robinhood Assets (Jersey) Limited (RHJ)**, all ERC-20 · 18 decimals · Chainlink-oracled. Canonical list: `docs.robinhood.com/chain/contracts/`.

**Position for Blue Agent:** be the *default primitive layer* every RH RWA builder wires their agent through — before Rialto, Arcus, or a bespoke SDK. Same play as `blue_stream` for Base trending, but for tokenized equities.

---

## The 30 candidate skills, grouped

### 1 · Lookup / registry (foundational — everything else depends on these)

| # | id | Input | Output | Data source | Cost |
|---|---|---|---|---|---|
| L1 | `hub_rh_stock_token` | ticker / company | contract + decimals + price | curated registry + RH RPC + GeckoTerminal | $0.05 |
| L2 | `hub_rh_rwa_index` | none | full catalog (26 tokens) | curated registry | $0.02 |
| L3 | `hub_rh_stock_search` | fuzzy query | top-N matches | curated registry (Levenshtein) | $0.02 |
| L4 | `hub_rh_rwa_verify` | contract addr | is-canonical? issuer? | registry lookup | free |

### 2 · Market data (live)

| # | id | Input | Output | Data source | Cost |
|---|---|---|---|---|---|
| M1 | `hub_rh_stock_quote` | ticker | Chainlink `latestRoundData` price | on-chain Chainlink feed | $0.03 |
| M2 | `hub_rh_stock_ohlc` | ticker, timeframe | candle series | GeckoTerminal pool history | $0.05 |
| M3 | `hub_rh_stock_liquidity` | ticker | pool addr + TVL + depth | GeckoTerminal + on-chain V3 slot0 | $0.05 |
| M4 | `hub_rh_stock_movers` | none | top gainers/losers 24h | GeckoTerminal batch | $0.05 |
| M5 | `hub_rh_stock_arb` | ticker | Chainlink price vs DEX spot Δ | 2× on-chain reads | $0.05 |

### 3 · Execution / trading

| # | id | Input | Output | Data source | Cost |
|---|---|---|---|---|---|
| X1 | `hub_rh_stock_swap_quote` | ticker, side, amount | quote (price impact, gas) | RH Uniswap V3 quoter | $0.05 |
| X2 | `hub_rh_stock_swap_prepare` | quote | unsigned tx calldata | build swap tx | $0.05 |
| X3 | `hub_rh_stock_swap_route` | in, out, amount | best route across pools | on-chain path finder | $0.10 |

### 4 · Portfolio / holdings

| # | id | Input | Output | Data source | Cost |
|---|---|---|---|---|---|
| P1 | `hub_rh_stock_holdings` | wallet | all RWA balances + USD value | 26× multicall balanceOf + prices | $0.05 |
| P2 | `hub_rh_stock_pnl` | wallet | unrealized PnL per position | holdings + entry avg from Transfer logs | $0.20 |
| P3 | `hub_rh_portfolio_rebalance` | wallet, target allocation | swap plan (multi-hop) | holdings + quoter | $0.20 |
| P4 | `hub_rh_sector_basket` | sector, amount | multi-buy plan (e.g. "top 5 tech") | curated sector map + quotes | $0.10 |

### 5 · Discovery / analytics

| # | id | Input | Output | Data source | Cost |
|---|---|---|---|---|---|
| D1 | `hub_rh_stock_holders` | ticker | top holders + concentration | Blockscout API | $0.05 |
| D2 | `hub_rh_stock_flow` | ticker | buy vs sell pressure 24h | GeckoTerminal trades feed | $0.10 |
| D3 | `hub_rh_stock_new_listings` | since ts | newly deployed RWA tokens | Blockscout token discovery | $0.05 |
| D4 | `hub_rh_stock_beacon_check` | ticker | proxy admin + upgrade history | on-chain slot reads | $0.05 |
| D5 | `hub_rh_stock_correlations` | tickers[] | on-chain price correlation matrix | Chainlink history | $0.10 |

### 6 · Agent skills (higher-order, uses lookup + execution + state)

| # | id | Input | Output | Data source | Cost |
|---|---|---|---|---|---|
| A1 | `hub_rh_rwa_dca` | ticker, amount, cadence | session-key DCA schedule | extends existing `blue_dca` | $0.20 |
| A2 | `hub_rh_stock_alert` | ticker, threshold | webhook / TG alert reg | KV store + cron | $0.10 |
| A3 | `hub_rh_stock_report` | ticker | on-chain vol + real-world news brief | GeckoTerminal + Venice web-search | $0.20 |
| A4 | `hub_rh_stock_agent_brief` | ticker | LLM-authored "why now" narrative | Venice with citations | $0.20 |

### 7 · Cross-chain / bridge

| # | id | Input | Output | Data source | Cost |
|---|---|---|---|---|---|
| B1 | `hub_rh_bridge_route` | asset, from, to | best bridge path Base ↔ RH | orbit-bridge + Bankr | $0.05 |
| B2 | `hub_rh_usdg_route` (#103) | amount | cheapest USDG acquisition | quoter | $0.05 |

### 8 · Builder / embed (the *pitch* to Vlad)

| # | id | Input | Output | Data source | Cost |
|---|---|---|---|---|---|
| E1 | `hub_rh_rwa_embed_kit` | ticker | JSX + wagmi snippet builder can paste | template | $0.05 |
| E2 | `hub_rh_rwa_readme` | ticker | auto README section for integrator docs | template + Bankr LLM | $0.05 |
| E3 | `hub_rh_rwa_pricing_kit` | ticker | Chainlink-feed React hook code | template | $0.05 |

---

## Ranking — recommended ship order

Rank = **impact for the builder × moat for BlueAgent × build effort**.

### Wave 1 — foundation (ship this week, ~2 hours)

1. **L1 `hub_rh_stock_token`** — every other tool needs this. Also the demo for Vlad.
2. **L2 `hub_rh_rwa_index`** — free once L1 is built. Enables portfolio scan.
3. **M1 `hub_rh_stock_quote`** — on-chain Chainlink is the *definitive* answer. Positions us as "we read the oracle, we don't invent prices".
4. **P1 `hub_rh_stock_holdings`** — turns "what do I own" into a paid answer. High retention.

**Why this wave first:** these four unlock everything downstream and are the ones any builder embedding stock tokens will call *first*.

### Wave 2 — trading + agent (post-launch, ~4 hours)

5. **X1 `hub_rh_stock_swap_quote`** — reuse existing RH Uniswap V3 swap infra
6. **A1 `hub_rh_rwa_dca`** — extend existing `blue_dca` (Task #92) to RH RWA
7. **A2 `hub_rh_stock_alert`** — Chainlink-triggered alerts, cron-driven
8. **E1 `hub_rh_rwa_embed_kit`** — the "pitch to Vlad" tool: paste this into your app

### Wave 3 — analytics moat (nice-to-have, ~4 hours)

9. **M4 `hub_rh_stock_movers`** — daily digest primitive
10. **D1 `hub_rh_stock_holders`** — whale-tracker style
11. **D2 `hub_rh_stock_flow`** — buy/sell pressure signal
12. **M5 `hub_rh_stock_arb`** — Chainlink vs DEX spread — genuine trading signal

### Deprioritized (parking lot)

- D5 correlations (compute-heavy, low near-term value)
- P3 rebalance (need holdings + quotes to be rock-solid first)
- D4 beacon check (governance nerd niche)
- B2 already exists as pending Task #103

---

## Public-good angle — pitch to Robinhood team

Frame these as **the composable primitive layer for the RH RWA ecosystem**:

- Every one of the ~26 tokens gets Chainlink-accurate on-chain quotes without the builder wiring Chainlink themselves (M1).
- Every builder embedding a "buy MSTR" button gets `hub_rh_rwa_embed_kit` (E1) → 3 lines of code instead of hunting the docs.
- Every wallet gets `hub_rh_stock_holdings` (P1) → portfolio widget with zero backend.
- x402 metering means **no rate limits, no API keys, pay-per-call USDC** — perfect for autonomous agents Vlad's tweet is targeting.

**Suggested opening move:** ship Wave 1, then reply to Vlad's tweet demoing L1 + P1 + E1 with a live Blue Chat clip. Same play as $BLUEAGENT Virtuals launch.

---

## Open questions before Wave 1 code

1. **Chainlink feed addresses.** Docs list "every stock token has a live feed" but the address table is at a URL too large to snapshot inline. First step of Wave 1 = fetch that table + freeze it into a local map (or read it dynamically on first call and cache in KV). Cheaper: cache.
2. **Late listings.** MSTR is on-chain but not in `docs.robinhood.com/chain/contracts/` yet. Registry must have a `mode: "docs" | "blockscout-verified"` fallback so L1 doesn't miss new tokens for 24-48h.
3. **Permissioned tokens.** Some RWAs may be KYC-gated (only whitelisted wallets can hold). If any RHJ token has an on-chain allowlist, we need a `permissioned: true` flag in the registry so `hub_rh_stock_swap_quote` warns the caller upfront.
4. **Pricing consistency.** All Wave 1 tools ≤ $0.05 to encourage agents to call them freely. Wave 2 trading tools $0.05–0.20. Wave 3 analytics $0.05–0.10.
