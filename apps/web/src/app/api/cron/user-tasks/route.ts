/**
 * Blue Chat — the tick that makes "daily at 09:00" mean 09:00.
 *
 * Runs every 5 minutes from `vercel.json`. Everything below is shaped by two
 * facts that make this different from the other crons in this repo: it spends
 * REAL USER CREDITS, and it runs against a KV budget that has been exceeded
 * three times (#148).
 *
 * ── Cost per idle tick: ONE read ─────────────────────────────────────────────
 * The first thing this route does is read `crons:next`, a single integer: the
 * earliest moment any owner has a task due. If that is in the future, it returns
 * immediately — it does not read the owners set, and it does not touch a single
 * wallet record. 288 ticks/day × 1 read ≈ 8.6k reads/month, flat, no matter how
 * many users enrol. The naive shape (scan every owner every 5 minutes) costs
 * 288 × N reads/day and would put the project back in suspension at a few
 * hundred users. `unset` means nobody has ever enrolled, and is also a return.
 *
 * ── Missed windows are SKIPPED, never replayed ───────────────────────────────
 * `nextFireAt` always returns a future instant, so a task whose window passed
 * while the app was down runs ONCE, at the next window. This is the single most
 * important behaviour here: each run debits credits and can call paid tools, so
 * "catch up on the seven runs you missed" is a way to empty a wallet overnight.
 * Losing a run is recoverable; charging for six the user never asked for is not.
 *
 * ── Out of credits pauses the task, it does not retry it ─────────────────────
 * `/api/cron/run` reports insufficient credits as a structured field rather than
 * an error string. When we see it, the task is switched off with a
 * `pausedReason` the panel renders. The alternative — leave it active — means
 * re-attempting a run that cannot succeed every 5 minutes forever, which burns
 * the tool budget and the KV budget to produce nothing. The user re-enables it
 * after topping up, which also clears the reason.
 *
 * ── One tick at a time, and only a few runs per tick ─────────────────────────
 * A `kvTryLock` guard stops two overlapping invocations from double-charging the
 * same task, and `MAX_RUNS_PER_TICK` bounds how much money one tick can spend if
 * something goes wrong upstream. Anything not reached this tick is still due
 * next tick — the watermark is left where it belongs.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (or `?secret=`) — the house pattern.
 */
import { NextRequest, NextResponse } from "next/server";
import { kvTryLock, kvDel } from "@/lib/kv";
import {
  listOwners,
  readOwnerTasks,
  writeOwnerTasks,
  readWatermark,
  writeWatermark,
  earliestNextAt,
  unenroll,
  MAX_RESULT_CHARS,
  type ScheduledTask,
} from "@/lib/scheduled-tasks";
import { nextFireAt } from "@/lib/cron-schedule";

export const runtime = "nodejs";
/**
 * A single chat run with tools can take most of a minute; the fetch below caps
 * itself at 90s and we allow a handful per tick. 300 is the ceiling this plan
 * supports and is already used by one other route in the repo.
 */
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const BASE_URL    = process.env.NEXT_PUBLIC_APP_URL ?? "https://blueagent.dev";

const LOCK_KEY = "crons:tick:lock";
/** Comfortably longer than a full tick, short enough that a crash self-heals. */
const LOCK_TTL_S = 6 * 60;

/**
 * Bounded unattended spend. Ten daily tasks across all users landing in one
 * 5-minute window is plausible; a hundred is a bug, and this is where that bug
 * stops costing money. The remainder stays due and is picked up next tick.
 */
const MAX_RUNS_PER_TICK = 8;

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return process.env.NODE_ENV !== "production";
  const authHeader  = req.headers.get("authorization") ?? "";
  const secretParam = new URL(req.url).searchParams.get("secret") ?? "";
  return authHeader === `Bearer ${CRON_SECRET}` || secretParam === CRON_SECRET;
}

// ─── Running one task ────────────────────────────────────────────────────────

type RunOutcome =
  | { kind: "ok"; text: string }
  | { kind: "insufficient"; needed?: number; balance?: number }
  | { kind: "error"; message: string };

/**
 * Execute one task through `/api/cron/run`, which proxies `/api/chat` with the
 * full real-data Hub tool set.
 *
 * We call it rather than `/api/chat` directly so there is ONE owner of "turn a
 * stored prompt into an answer" — the slash-command expansion and the SSE
 * collection live there, and the browser's "Run now" button goes through the
 * same path. Two copies of that would drift the way the chat price tables did.
 *
 * The owner's wallet is forwarded as `address`, so the run is billed to the
 * person who scheduled it and paid Hub tools are authorised as them. Since
 * PR #386 that route attaches no internal key of its own, so a scheduled run
 * costs exactly what typing the same prompt would cost.
 */
async function runTask(task: ScheduledTask, wallet: string): Promise<RunOutcome> {
  try {
    const res = await fetch(`${BASE_URL}/api/cron/run`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ prompt: task.prompt, tier: task.tier, address: wallet }),
      signal:  AbortSignal.timeout(95_000),
    });

    const data = (await res.json().catch(() => ({}))) as {
      result?: string;
      error?: string;
      insufficientCredits?: { needed?: number; balance?: number };
    };

    if (data.insufficientCredits) {
      return { kind: "insufficient", ...data.insufficientCredits };
    }
    if (!res.ok) {
      return { kind: "error", message: data.error ?? `HTTP ${res.status}` };
    }
    const text = (data.result ?? "").trim();
    // An empty answer is a failure, not a result. Storing "" would render as a
    // successful run that says nothing, which is worse than saying it failed.
    if (!text) return { kind: "error", message: "The model returned nothing." };
    return { kind: "ok", text: text.slice(0, MAX_RESULT_CHARS) };
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
}

// ─── Tick ────────────────────────────────────────────────────────────────────

interface TickSummary {
  ran:     number;
  failed:  number;
  paused:  number;
  owners:  number;
  skipped: number;   // owners whose record could not be read this cycle
}

async function tick(now: number): Promise<TickSummary & { nextAt: number | null }> {
  const summary: TickSummary = { ran: 0, failed: 0, paused: 0, owners: 0, skipped: 0 };

  const owners = await listOwners();
  summary.owners = owners.length;

  // The earliest future `nextAt` seen anywhere this pass. Recomputed from
  // scratch rather than adjusted, so a stale watermark self-corrects every time
  // a full pass happens.
  let soonest: number | null = null;
  let budget  = MAX_RUNS_PER_TICK;

  for (const wallet of owners) {
    const read = await readOwnerTasks(wallet);

    if (read.status === "unavailable") {
      // Could not read — skip, do NOT write. Writing here would replace a real
      // schedule with an empty one on a throttle. Pull the wake-up in so the
      // next tick retries them promptly.
      summary.skipped++;
      soonest = soonest === null ? now + 60_000 : Math.min(soonest, now + 60_000);
      continue;
    }
    if (read.status === "empty") {
      // In the owners set with no record: a half-finished un-enrol, or a wiped
      // key. Drop the membership so it stops costing a read every pass.
      await unenroll(wallet);
      continue;
    }

    const tasks = read.record.tasks;
    let dirty = false;

    for (const task of tasks) {
      if (!task.active) continue;
      if (!Number.isFinite(task.nextAt) || task.nextAt > now) continue;

      if (budget <= 0) {
        // Out of runs for this tick. Leave `nextAt` in the past so the task is
        // still due, and make sure we come back promptly.
        soonest = soonest === null ? now : Math.min(soonest, now);
        continue;
      }
      budget--;

      const outcome = await runTask(task, wallet);
      dirty = true;
      task.lastRun = Date.now();

      if (outcome.kind === "ok") {
        task.lastResult = outcome.text;
        task.lastError  = undefined;
        summary.ran++;
      } else if (outcome.kind === "insufficient") {
        // Switch it off rather than retrying every 5 minutes forever. The user
        // re-enables after topping up, and re-enabling clears this reason.
        task.active = false;
        task.pausedReason =
          typeof outcome.needed === "number" && typeof outcome.balance === "number"
            ? `Paused — needed ${outcome.needed} credits, balance was ${outcome.balance}. Top up and switch it back on.`
            : "Paused — not enough credits. Top up and switch it back on.";
        task.lastError = task.pausedReason;
        summary.paused++;
      } else {
        // A transient failure does not pause the task: it records the error and
        // moves to the next window. Pausing on one bad upstream response would
        // silently disable everyone's tasks during an outage.
        task.lastError = outcome.message.slice(0, 300);
        summary.failed++;
      }

      // Advance from now, not from the missed slot — a task does not owe runs
      // for windows it slept through. See `nextFireAt`.
      task.nextAt = nextFireAt(task, Date.now());
    }

    if (dirty) {
      try {
        await writeOwnerTasks(wallet, tasks);
      } catch (e) {
        // The run already happened and was already paid for. Losing the result
        // is the smaller harm; what we must not do is let the failure look like
        // a clean pass, because `nextAt` did not persist either and the task
        // would fire again next tick — a double charge.
        console.error(`[cron:user-tasks] write failed for ${wallet}: ${(e as Error).message}`);
        soonest = soonest === null ? now + 60_000 : Math.min(soonest, now + 60_000);
        continue;
      }
    }

    const mine = earliestNextAt(tasks);
    if (mine !== null) soonest = soonest === null ? mine : Math.min(soonest, mine);
  }

  return { ...summary, nextAt: soonest };
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();

  // 1. The one-read fast path. See the header — this is what keeps the whole
  //    feature inside the KV budget.
  const mark = await readWatermark();
  if (mark.status === "unavailable") {
    // Cannot tell whether anything is due. Do nothing: a skipped cycle costs a
    // task at most 5 minutes of lateness, and guessing "probably due" would run
    // a full owner scan on every throttled tick — exactly the load that caused
    // the throttle.
    return NextResponse.json({ status: "skipped", reason: "watermark unavailable" }, { status: 200 });
  }
  if (mark.status === "unset") {
    return NextResponse.json({ status: "idle", reason: "no schedules" });
  }
  if (mark.at > now) {
    return NextResponse.json({ status: "idle", nextAt: mark.at });
  }

  // 2. One tick at a time. `held` means another invocation is mid-pass; `error`
  //    means we learned nothing about the lock, and running anyway risks
  //    double-charging a task, so both decline.
  const lock = await kvTryLock(LOCK_KEY, { at: now }, LOCK_TTL_S);
  if (lock !== "acquired") {
    return NextResponse.json({ status: "skipped", reason: `lock ${lock}` }, { status: 200 });
  }

  try {
    const result = await tick(now);

    // 3. Move the wake-up to the next real deadline. `writeWatermark` clamps it
    //    to at most an hour out, so even a wrong answer here self-corrects.
    await writeWatermark(result.nextAt ?? now + 60 * 60 * 1000, Date.now());

    return NextResponse.json({ status: "ok", ...result });
  } catch (e) {
    // Leave the watermark in the past so the next tick retries rather than
    // sleeping on a half-finished pass.
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    await kvDel(LOCK_KEY);
  }
}

/** Vercel Cron issues GETs; POST is here so the same URL can be triggered by hand. */
export const POST = GET;
