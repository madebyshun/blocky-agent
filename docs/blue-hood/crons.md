# Blue Hood — cron registry (T-B.1 #2)

Every automation Blue Hood relies on, one row per job. Reviewer's rule:
"cái nào tự chạy, schedule gì, cái nào manual-only. Bắt buộc trước prod 24/7."

## Automatic (Vercel Cron)

Registered in `vercel.json` under `crons[]`. Vercel Pro allows sub-daily
cadence (`* * * * *`); we do not run tighter than every 2 minutes to
respect GT rate-limits (see `poller.ts`).

| Path | Schedule | Cadence | Purpose |
|---|---|---|---|
| `/api/cron/blue-hood/poll` | `*/2 * * * *` | every 2 min | one M5 poll cycle over the watchlist (24 tokens, 3s stagger ≈ 72s wall time), runs rule engine + grader, writes `bh:snapshot:latest` + `bh:arrow:*`. Auth: `Authorization: Bearer $CRON_SECRET`. |
| `/api/cron/blue-hood/sparkline-refresh` | `*/15 * * * *` | every 15 min | refreshes `bh:spark:{TICKER}` (24 tokens, 3s stagger, TTL 20 min). Runs OUTSIDE the poll hot path so the 72s cycle doesn't grow. Auth: `Authorization: Bearer $CRON_SECRET`. |
| `/api/cron/blue-hood/brief-worker` | `* * * * *` | every 1 min | drains `bh:brief:queue` (async-brief refactor). Pops up to `BH_BRIEF_BATCH` (default 8) arrow ids, fetches A4 brief per arrow, attaches, writes chat card, runs Web Push fan-out. Poll cycle no longer blocks on A4. `BH_BRIEF_BATCH` clamped [1, 20]. Auth: `Authorization: Bearer $CRON_SECRET`. |
| `/api/cron/feed/daily` | `0 9 * * *` | daily 09:00 UTC | Blue Feed daily digest (unrelated to Blue Hood; here for the whole-app view). |
| `/api/cron/research-loop` | `0 6 * * *` | daily 06:00 UTC | Blue Feed autonomous research (unrelated to Blue Hood; here for the whole-app view). |

## Automatic (GitHub Actions)

| Workflow | Schedule | Cadence | Purpose |
|---|---|---|---|
| `.github/workflows/rh-rwa-semantic-smoke.yml` | `0 */6 * * *` | every 6 h | Runs `apps/web/scripts/semantic-smoke.ts` against prod for the FROZEN 30 RH RWA skills. Green cron → Gate 2 stays closed. Unrelated to Blue Hood layer. |

## Manual-only (no scheduler)

| Path | Notes |
|---|---|
| `POST /api/cron/blue-hood/purge?confirm=1` | Wipe all arrow records + reset serial counter. Used before prod launch so `#0001` is the engine's first real arrow. Auth: CRON_SECRET. |
| `POST /api/cron/blue-hood/seed-test-arrow` | Dev-only synthetic arrow (always `origin: "seeded"`, hidden from public feed). Local UI smoke path. Endpoint 404s in prod. |
| `GET /api/hood/llm-health` | Manual poll of the Virtuals→Venice→Bankr chain. Called by `scripts/blue-hood-smoke.ts` (see BH_SMOKE_STRICT). |

## Env dependencies

- `CRON_SECRET` — required for both Blue Hood crons above. Set in Vercel
  project env (same value that gates every other cron here).
- `INTERNAL_SERVICE_KEY` — required for the internal-bypass path the
  poller uses to call M5 / M2 / M3 / D1 / A4 tools. Set in Vercel prod.
- `VIRTUALS_API_KEY` (primary), `VENICE_INFERENCE_KEY`, `BANKR_API_KEY`
  — LLM chain for A4 brief attachment. `smoke` warns locally when
  these fail; STRICT mode (CI) hard-fails.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — Web Push
  fan-out (T-D D3). Generated once with
  `npx web-push generate-vapid-keys` (both keys are base64-url strings;
  `VAPID_SUBJECT` is a `mailto:` URL, e.g. `mailto:blueagent@blueagent.dev`).
  Missing → `pushArrowToAll` logs `[push] VAPID keys missing — skipping
  fan-out` and no-ops; the arrow still fires and the inbox still lists
  it, only the browser notification is suppressed. Rotate by generating a
  new pair, updating Vercel env, and redeploying — existing subscribed
  browsers will silently drop until they re-`Enable alerts`.

## Dev warning — Vercel Cron only fires on production

Localhost + Vercel preview URLs do NOT run the scheduled crons above.
The `vercel.json` entries only activate on the production deployment
under `blueagent.dev`. This means:

- A fresh dev server sees empty `bh:snapshot:latest`, empty
  `bh:spark:*`, empty arrow feed.
- The drift board renders `— · — · —` in the 24h column forever
  until you populate the sparkline cache manually.

**Fix**: `npm run hood:kick-crons` (from `apps/web/`) — POSTs both
`sparkline-refresh` and `poll` with the CRON_SECRET loaded from
`.env.local`. Takes ~3 min (24 tokens × 3s stagger, twice).

Override target with `BH_KICK_TARGET=https://<preview>.vercel.app npm run hood:kick-crons`
to warm a preview deploy against real data.

## Verifying a fresh deploy

1. Push a commit — Vercel picks up `vercel.json` `crons[]` diff on
   deploy. Confirm registration under **Vercel Dashboard → Project →
   Settings → Cron Jobs**.
2. Trigger each once manually:
   `curl -X POST "$URL/api/cron/blue-hood/poll" -H "Authorization: Bearer $CRON_SECRET"`
   `curl -X POST "$URL/api/cron/blue-hood/sparkline-refresh" -H "Authorization: Bearer $CRON_SECRET"`
   `curl -X POST "$URL/api/cron/blue-hood/brief-worker" -H "Authorization: Bearer $CRON_SECRET"` (drains any pending briefs from the last poll)
3. After ~5 min, check the metric strip on `/hood` — TOKENS WATCHED
   should show 24/26, TVL SCANNED > $500k, 24h sparkline columns
   populated.
