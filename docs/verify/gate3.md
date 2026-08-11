# Gate 3 — Concurrency / rate-limit

Status: **PASS on first attempt** — no cache tier needed at current traffic.

## Test setup

`apps/web/scripts/gate3-concurrency.ts` — local mode via `HANDLERS` imports. Two scenarios per reviewer spec:

- **3.1**: 20× concurrent `rh-stock-movers` (heaviest GT consumer — iterates the whole RWA registry).
- **3.2**: mixed 10× M1 `rh-stock-quote` + 5× M5 `rh-stock-arb` + 5× D2 `rh-stock-flow`.

## Results (2026-07-17)

### Scenario A — 20× M4 concurrent

| metric | value |
|---|---|
| success | 20/20 |
| p50 | 767ms |
| p95 | 1502ms |
| max | 1502ms |
| 429 signals leaked to client | 0 |
| errors | 0 |

### Scenario B — 10 M1 + 5 M5 + 5 D2 mixed

| metric | value |
|---|---|
| success | 20/20 |
| p50 | 432ms |
| p95 | 459ms |
| max | 459ms |
| 429 signals | 0 |
| errors | 0 |

## Why we didn't need to add a new cache tier

The existing in-memory memo cache in `apps/web/src/lib/robinhood/rwa-market.ts` (60s TTL, `fetchJson<T>`) already collapses:
- Duplicate GT `/tokens/{addr}/pools` calls (M4 iterates all 26 RWA tokens; the first invocation warms the cache and the 19 concurrent duplicates hit the cache).
- Same for `poolsForToken` result reuse across M1/M5/D2 for the same ticker.

Chainlink RPC calls are single-shot per feed and rate-limited generously enough on RH mainnet.

## Reviewer's decision rule

> QUYẾT ĐỊNH TẠI GATE: nếu xuất hiện 429/timeout → implement cache tầng NGAY

**No 429s appeared**, so per the reviewer's stated rule, no cache implementation is needed at this gate. The in-memory memo is sufficient. If prod traffic later triggers real 429s, wire a shared KV cache (registry 1h, M4/M1 60s, M5/D2 30s, key = `tool:params`) as a hotfix.

## Gate 3 verdict

- Scenario A: ✅ 20/20 · p95 1502ms · 0 429s
- Scenario B: ✅ 20/20 · p95 459ms · 0 429s
- **PASS on first run** — no new cache layer required at this traffic level.
