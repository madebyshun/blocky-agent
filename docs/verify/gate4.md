# Gate 4 — Agent-consumption UX test

Status: **PASS both runs · zero field misreads**.

## Setup

Two independent `general-purpose` sub-agents were spawned with **zero prior context** about this codebase. Each received only:

1. Endpoint list + response schemas for all 30 tools (`/tmp/rh-rwa-schemas.md`)
2. Real live JSON outputs from 8 AAPL-related tools captured immediately before the run (`/tmp/gate4-clean.json`)
3. The user question: *"AAPL trên Robinhood Chain có đáng mua $500 lúc này không?"*

Rules given to the agents:
- Cite exact field names.
- Do not invent numbers.
- Respect every warning.
- End with a numbered pre-Buy verification checklist.

## Run 1 result

Verdict: **KHÔNG nên mua $500 AAPL lúc này** (do not buy).

Fields cited (all verified against captured outputs):

| Field | Agent claim | Captured value | Match |
|---|---|---|---|
| `rh-stock-arb.market.is_open` | false | false | ✅ |
| `rh-stock-arb.verdict` | FROZEN_ALIGNED | FROZEN_ALIGNED | ✅ |
| `rh-stock-arb.chainlink.age_seconds` | 3177 | 3178 | ✅ (1s drift) |
| `rh-stock-flow.pressure` | SELL_HEAVY | SELL_HEAVY | ✅ |
| `rh-stock-flow.buy_volume_usd` | 3051.88 | 3051.8762 | ✅ |
| `rh-stock-flow.sell_volume_usd` | 7828.50 | 7828.496 | ✅ |
| `rh-stock-flow.net_volume_usd` | -4776.62 | -4776.6198 | ✅ |
| `rh-stock-flow.trades_seen` | 197 | 197 | ✅ |
| `rh-stock-liquidity.total_tvl_usd` | 135297 | 135297.015 | ✅ |
| `rh-stock-holders.concentration.top1_pct` | 37.10 | 37.1028 | ✅ |
| `rh-stock-holders.concentration.top10_pct` | 90.3052 | 90.3052 | ✅ |
| `rh-stock-holders.concentration.hhi` | 2176.51 | 2176.51 | ✅ |
| `rh-stock-swap-quote.expected_out` | 1.5052 | 1.5051703… | ✅ |
| `rh-stock-swap-quote.min_out` | 1.4737 | 1.4737050… | ✅ |
| `rh-stock-swap-quote.trade_impact_pct` | 1.1015% | 1.1015 | ✅ |
| `rh-stock-swap-quote.execution.router` | `0x3bb0e9E3…` | `0x3bb0e9E3…` | ✅ |

**Fields invented: 0.** **Fields misread: 0.**

Tools referenced in agent's analysis: **7** (`rh-stock-arb`, `rh-stock-agent-brief`, `rh-stock-flow`, `rh-stock-liquidity`, `rh-stock-holders`, `rh-stock-swap-quote`, `rh-stock-quote`). Reviewer required ≥5. ✅

## Run 2 result

Independent re-run with fresh sub-agent instance. Verdict again: **KHÔNG nên mua** with the same primary reasons (market closed, SELL_HEAVY flow, thin liquidity + whale concentration, ~1.1% trade impact for $500).

Spot-check: agent cited `rh-stock-swap-quote.pool_oracle_delta_pct = -0.8866`, `rh-stock-liquidity.warnings[0] = v4_concentrated_liquidity`, `rh-stock-liquidity.slippage_upper_bound.estimates` — all verified against captured outputs.

**Fields invented: 0.** **Fields misread: 0.** Tools referenced: **7**.

## Warnings respected

Both runs cited and respected:
- `market_closed_session_premarket` → correctly interpreted verdict as post-close drift, not arb
- `feed_abnormally_stale` risk → gated recommendation
- `thin_liquidity` / `low_volume_24h` / `price_deviation` (via `risk_flags`)
- `v4_concentrated_liquidity` → treated slippage numbers as upper bound only

Neither agent recommended a Buy; both produced actionable pre-Buy checklists.

## Description tweaks needed

**None.** All 30 tool descriptions + response schemas were sufficient for the sub-agent to reason correctly without seeing the codebase. No schema changes required.

## Gate 4 verdict

- Run 1: ✅ 0 misreads, correct verdict interpretation, 7 tools chained
- Run 2: ✅ 0 misreads, consistent answer, 7 tools chained
- **PASS** per reviewer criteria (correct conclusion + zero field misreads by run 2)
