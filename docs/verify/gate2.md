# Gate 2 — Semantic smoke CI

Status: **PASS on prod** (22/22 via `workflow_dispatch` 2026-07-17). Awaiting 2 consecutive green scheduled cron runs to formally close per reviewer's rule.

## Post-report hotfix (2026-07-17, PR #205)

While closing Gate 2 we found the CI script + handler didn't line up on prod — both fixed in PR #205:

1. **CI script was one header short.** Handler bypass requires `X-Blue-Internal` **and** `X-Blue-Service: internal`; script only sent the first, so paid tools returned 402 `WALLET_REQUIRED` even with a correct key. Loophole-close is intentional in `route.ts` (line 225 — closes "guest calls paid tool with just the key"); CI just wasn't following the contract.
2. **Free tools 503'd.** `if (!handler || !priceUnits)` treated `priceUnits === 0` as falsy → L4 `rh-rwa-verify` (@ $0.00) was unreachable. Changed to `priceUnits === undefined` in both call sites.

Both fixes landed in commit `<merge>` and deployed to prod. First `workflow_dispatch` on the new deploy → **22/22 pass** (run [29572993869](https://github.com/madebyshun/blue-agent/actions/runs/29572993869)).

## Assertions implemented (`apps/web/scripts/semantic-smoke.ts`)

Both modes share the same assertion set:
- `TARGET` env → HTTP mode (used by CI against prod, requires `INTERNAL_SERVICE_KEY` matching prod)
- no `TARGET` → local mode (imports `HANDLERS` directly, no HTTP)

### Assertions per reviewer spec

- **M5**: `verdict ∈ {ALIGNED, LONG_DEX, SHORT_DEX, FROZEN_ALIGNED, PREMARKET_DRIFT, AFTERHOURS_DRIFT, INSUFFICIENT_DATA}` + `market.is_open` matches computed NY clock.
- **X1**: `min_out < expected_after_impact ≤ expected_out`, `spot_source === "pool"` (with 1× retry to survive GT rate-limit).
- **M4**: every ranked entry passes dust floor ($5k TVL + $500 24h volume); gainers/losers disjoint.
- **M2**: `candles_returned ≥ 1` OR one of the "honesty" warnings (`insufficient_history`, `ohlc_unavailable`, `single_candle`, `no_pool`).
- **L4**: MSTR (`0xec262a75…`) → `CANONICAL`; random address → non-CANONICAL.
- **A4**: `llm.provider` non-null; if `web_search_used=false`, `no_web_search_this_run` warning required.

## Local run result (2026-07-17)

```
── SUMMARY ── 22/22 pass
```

Output verified on main branch, no code changes needed to reach 22/22.

## CI workflow (`.github/workflows/rh-rwa-semantic-smoke.yml`)

- Triggers: PR (paths-filtered to RH RWA files), 6h cron, `workflow_dispatch`.
- Runs against `TARGET=https://blueagent.dev` with `INTERNAL_SERVICE_KEY` GitHub secret.
- Exit 1 on any assertion mismatch — blocks PR merge / marks cron red.
- Reviewer requirement: **2 consecutive green cron runs on prod** before promoting to PASS.

## Action item

- Add GitHub secret `INTERNAL_SERVICE_KEY` (matching the Vercel `blueagent-web-new` production value) to the repo. Without it, the CI job exits 2 with a clear error.
- After secret set + first cron fires, watch the Actions tab for 2 consecutive greens.

## Gate 2 verdict

- Local: ✅ 22/22 assertions pass
- CI workflow: ✅ committed + wired to prod
- Prod dispatch: ✅ 22/22 (2026-07-17 10:19 UTC, run 29572993869)
- Prod cron: ⏸ awaiting 2 consecutive scheduled greens (next fires at ~12:00 UTC)
