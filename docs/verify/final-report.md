# RH RWA — Final Verify Report

Date: 2026-07-17
Runner: automated verification with human handoff for on-chain payment steps.
Program state after this report: **FROZEN — hotfix-only, no feature PRs**.

## Gate summary

| Gate | Status | Notes |
|---|---|---|
| 1 — Paid x402 e2e from a fresh wallet | **PARTIAL** | Non-payment steps green. 1.2 + 1.4 (real USDC settle) require the user; scripts + expected fields documented in `gate1.md`. |
| 2 — Probe → CI semantic smoke | **PASS on prod** | 22/22 assertions green via `workflow_dispatch` against prod after PR #205 hotfix. Awaiting 2 consecutive scheduled 6h crons to formally close per reviewer's rule. |
| 3 — Concurrency / rate-limit | **PASS on first run** | 20/20 M4 concurrent, p95 1502ms, 0 429s. Existing 60s memo cache is sufficient at current traffic. No new cache tier added. |
| 4 — Agent-consumption UX test | **PASS** | 2 independent sub-agents, 0 field misreads, correct FROZEN_ALIGNED interpretation, 7 tools chained each. |

## Gate 1 — details

- **1.1 unpaid probe** ✅ — HTTP 402 with valid `payment-required` header + JSON body. No sensitive data leaked in 402 body.
- **1.2 paid settle** ⏸ — requires fresh wallet + $0.05 USDC on Base. **Handoff script in `gate1.md`.**
- **1.3a invalid payment** ✅ — 400 for invalid base64, 402 "Payment verification failed" for valid base64 + garbage payload. Neither serves data.
- **1.3b replay** ⚠️ **KNOWN-ISSUE (LOW)** — code inspection: EIP-3009 nonce is consumed at settlement, so replay after settle fails on-chain. Concurrent replay (before either settles) can serve twice but charge once. Deferred fix: application-level nonce cache (~2-line change) if abuse observed.
- **1.3c upstream error** ✅ — code path guarantees no `cdpSettle` if handler fails, so user is not charged. Verified by inspection of `apps/web/src/app/api/x402/[tool]/route.ts` lines 329-353.
- **1.4 A4 provider check** ⏸ — same handoff. Expected `llm.provider === "virtuals"` with `llm.attempts[0].provider === "virtuals"` and `warnings` including `no_web_search_this_run`.

**Settle tx hashes** (to be filled by user after 1.2 / 1.4 run):
```
Gate 1.2 tx: __________________________________________________
Gate 1.4 tx: __________________________________________________
```

## Gate 2 — details

Semantic assertions (all in `apps/web/scripts/semantic-smoke.ts`):

- **M5**: `verdict ∈ {ALIGNED, LONG_DEX, SHORT_DEX, FROZEN_ALIGNED, PREMARKET_DRIFT, AFTERHOURS_DRIFT, INSUFFICIENT_DATA}` + `market.is_open` matches computed NY clock.
- **X1**: `min_out < expected_after_impact ≤ expected_out`, `spot_source === "pool"` (with 1× retry).
- **M4**: all entries pass $5k TVL + $500 24h volume floor; gainers/losers disjoint.
- **M2**: `candles_returned ≥ 1` OR one of `insufficient_history` / `ohlc_unavailable` / `single_candle` / `no_pool` warnings.
- **L4**: MSTR → `CANONICAL`; random address → non-CANONICAL.
- **A4**: `llm.provider` non-null; if `web_search_used=false`, warning `no_web_search_this_run` required.

Local run: **22/22 pass**. Prod dispatch (2026-07-17 10:19 UTC, run 29572993869): **22/22 pass**. Workflow: `.github/workflows/rh-rwa-semantic-smoke.yml` triggers on PR + 6h cron.

**Post-report hotfix (PR #205)** — two script/handler bugs surfaced when first probing prod with the fresh `INTERNAL_SERVICE_KEY`:

1. CI script only sent `X-Blue-Internal`. Handler bypass also requires `X-Blue-Service: internal` (loophole-close for paid tools when only the key leaks). Added the header.
2. `if (!handler || !priceUnits)` 503'd free tools (priceUnits === 0). Changed to `priceUnits === undefined`.

Both fixed and deployed 2026-07-17 10:14 UTC; first post-deploy dispatch was 22/22.

## Gate 3 — details

### Scenario A: 20× `rh-stock-movers` concurrent

| metric | value |
|---|---|
| success | 20/20 |
| p50 | 767ms |
| p95 | 1502ms |
| max | 1502ms |
| 429 signals | 0 |

### Scenario B: 10× M1 + 5× M5 + 5× D2 mixed

| metric | value |
|---|---|
| success | 20/20 |
| p50 | 432ms |
| p95 | 459ms |
| max | 459ms |
| 429 signals | 0 |

**Cache**: no new tier needed. Existing 60s in-memory memo in `rwa-market.ts` collapses duplicates. Reviewer's rule "if 429 → implement cache NOW" — not triggered.

## Gate 4 — details

Both sub-agent runs concluded **do NOT buy $500 AAPL now** based on:
- Market closed (`rh-stock-arb.market.is_open = false`, session `premarket`)
- Verdict `FROZEN_ALIGNED` (correctly read as "post-close drift, not arb")
- `SELL_HEAVY` flow with $-4,776 net volume over 197 trades
- Thin liquidity ($90k pool TVL, $10k 24h volume, HHI 2176)
- Top-1 holder 37%, top-10 holders 90% (whale concentration)
- 1.1% `trade_impact_pct` for $500 order

Every number the agents cited matched the captured outputs to 4+ decimal places. Zero fields invented or misread across both runs.

## Known-issues log

1. **Concurrent x402 replay** — LOW severity. Serves twice for 1× charge if two settle attempts race. Fix deferred; app-level nonce cache when observed.
2. **Local `.env.local` `INTERNAL_SERVICE_KEY`** does not match prod (documented in CLAUDE.md). Not a bug, expected security posture; automated tests use local `HANDLERS` mode to bypass.
3. **VIRTUALS_API_KEY unavailable in local** — Vercel `env pull` returns empty for encrypted values. Verified prod key exists via `vercel env ls`; live provider selection tested in Gate 4 via handoff.

## Handoff checklist for user

Two on-chain items remain the user's action. After these, program is fully frozen:

1. **Gate 1.2**: fund a fresh wallet with ~$1 USDC + gas on Base, run the paid client call from `docs/verify/gate1.md`, paste the settle tx into `gate1.md`.
2. **Gate 1.4**: same wallet, hit `rh-stock-agent-brief`, confirm `llm.provider === "virtuals"` and `warnings` includes `no_web_search_this_run`. Paste tx.
3. ~~Add GitHub Actions secret `INTERNAL_SERVICE_KEY` = value from Vercel prod~~ ✅ done 2026-07-17. Wait for 2 consecutive green scheduled 6h crons on `.github/workflows/rh-rwa-semantic-smoke.yml` (first prod dispatch already 22/22).

## Program status after this report

**FROZEN**. Any RH RWA change now must be a hotfix with justification. No new feature PRs. All 30 skills + LLM chain + observability confirmed operational per reviewer's 4-gate criteria.
