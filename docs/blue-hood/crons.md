# Blue Hood — cron registry (T-B.1 #2)

Every automation Blue Hood relies on, one row per job. Reviewer's rule:
"cái nào tự chạy, schedule gì, cái nào manual-only. Bắt buộc trước prod 24/7."

## Automatic (Vercel Cron)

Registered in `vercel.json` under `crons[]`. Vercel Pro allows sub-daily
cadence (`* * * * *`); we do not run tighter than every 2 minutes to
respect GT rate-limits (see `poller.ts`).

**This table is pinned to `vercel.json` by `apps/web/scripts/docs-truth-check.ts`,
which runs in CI.** It has to be: three of these schedules had drifted from the
deployed value and two jobs were missing from the table entirely, so the doc was
describing a cadence nothing ran at.

| Path | Schedule | Cadence | Purpose |
|---|---|---|---|
| `/api/cron/blue-hood/poll` | `*/5 * * * *` | every 5 min | one M5 poll cycle over the watchlist (24 tokens, 3s stagger ≈ 72s wall time), runs rule engine + grader, writes `bh:snapshot:latest` + `bh:arrow:*`. Auth: `Authorization: Bearer $CRON_SECRET`. |
| `/api/cron/blue-hood/sparkline-refresh` | `*/30 * * * *` | every 30 min | refreshes `bh:spark:{TICKER}` (24 tokens, 3s stagger, TTL 20 min). Runs OUTSIDE the poll hot path so the 72s cycle doesn't grow. Auth: `Authorization: Bearer $CRON_SECRET`. |
| `/api/cron/blue-hood/brief-worker` | `*/3 * * * *` | every 3 min | drains `bh:brief:queue` (async-brief refactor). Pops up to `BH_BRIEF_BATCH` (default 8) arrow ids, fetches A4 brief per arrow, attaches, writes chat card, runs Web Push fan-out. Poll cycle no longer blocks on A4. `BH_BRIEF_BATCH` clamped [1, 20]. Auth: `Authorization: Bearer $CRON_SECRET`. |
| `/api/cron/blue-hood/alert-drain` | `*/2 * * * *` | every 2 min | drains the pending-alert queue to watchlist subscribers (Telegram DM + Web Push). Auth: `Authorization: Bearer $CRON_SECRET`. |
| `/api/cron/blue-hood/archive-watch` | `7 * * * *` | hourly, at :07 | watchdog over the arrow archive — detects holes in the series and reports them rather than silently backfilling. Auth: `Authorization: Bearer $CRON_SECRET`. |
| `/api/cron/research-loop` | `0 6 * * *` | daily 06:00 UTC | Autonomous builder-research loop; writes Aeon KV via `setAeonOutput`. Unrelated to Blue Hood; here for the whole-app view. |
| `/api/cron/user-tasks` | `*/5 * * * *` | every 5 min | Blue Chat background scheduled tasks — fires the tasks a user switched to Background so they run with the tab closed. Unrelated to Blue Hood; here for the whole-app view. Auth: `Authorization: Bearer $CRON_SECRET`. |

The `/api/cron/feed/daily` row was removed on 2026-09-02 when Blue Feed was
retired and its cron deleted from `vercel.json`. `research-loop` was labelled
"Blue Feed autonomous research" here, which was never true — it feeds Aeon KV
and is untouched by the retirement.

`/api/cron/user-tasks` is the only cron here that **spends real user credits**,
so three of its behaviours are load-bearing and are documented in the route
header rather than inferred from the cadence above:

- **An idle tick costs ONE KV read.** It reads `crons:next` — a single integer
  watermark of the earliest due task — and returns if that is in the future. The
  cost is ~8.6k reads/month *flat*, independent of user count. The naive shape
  (scan every owner every 5 min) is `288 × N` reads/day and would walk the
  project back into an Upstash suspension (#123, #148) at a few hundred users.
- **A missed window is skipped, never replayed.** `nextFireAt` only ever returns
  a future instant, so a task whose window passed during downtime runs once, at
  the next window. Losing one run is recoverable; silently charging for six the
  user never asked for is not.
- **Out of credits pauses the task, it does not retry it.** Insufficient credits
  come back from `/api/cron/run` as a structured field, and the task is switched
  off with a `pausedReason` the panel renders. Leaving it active would re-attempt
  a run that cannot succeed every 5 minutes forever.

## Automatic (GitHub Actions)

| Workflow | Schedule | Cadence | Purpose |
|---|---|---|---|
| `.github/workflows/rh-rwa-semantic-smoke.yml` | `0 */6 * * *` | every 6 h | Runs `apps/web/scripts/semantic-smoke.ts` against prod for the FROZEN 30 RH RWA skills. Green cron → Gate 2 stays closed. Unrelated to Blue Hood layer. |

## Manual-only (no scheduler)

| Path | Notes |
|---|---|
| `POST /api/cron/blue-hood/purge?confirm=1` | Wipe all arrow records + reset serial counter. Used before prod launch so `#0001` is the engine's first real arrow. Auth: CRON_SECRET. |
| `POST /api/cron/blue-hood/seed-test-arrow` | Dev-only synthetic arrow (always `origin: "seeded"`, hidden from public feed). Local UI smoke path. Endpoint 404s in prod. |
| `GET /api/hood/llm-health` | Manual poll of Virtuals, the only LLM gateway. Called by `scripts/blue-hood-smoke.ts` (see BH_SMOKE_STRICT). |

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
