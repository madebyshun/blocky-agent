/**
 * /api/chat/schedule — the server's copy of a wallet's background tasks.
 *
 * GET    → this wallet's schedule, with whatever the tick has run since last time
 * PUT    → replace it (an empty list means "stop running these in the background")
 * DELETE → leave the scheduler entirely
 *
 * ── The wallet comes from the session cookie. Always. ────────────────────────
 * No `?wallet=`, no `address` in the body — the same rule as `/api/workspace`,
 * for a stronger reason. A workspace is data; a schedule is a STANDING
 * INSTRUCTION TO SPEND. Every fire debits the owner's credit ledger and can call
 * paid Hub tools while nobody is watching. If this route trusted a body field,
 * anyone could install ten daily Deep tasks against a stranger's wallet and
 * drain it every morning until someone noticed. `/api/chat` accepts a
 * client-supplied address because the user is sitting in front of that message;
 * nobody is sitting in front of this one.
 *
 * That is also why enabling background runs is the one Blue Chat feature that
 * requires a signature. It is a real cost to the user and it is worth it.
 *
 * ── What the client may decide, and what it may not ──────────────────────────
 * It may decide label / schedule / time / tz / prompt / tier / active. It may
 * NOT decide `nextAt`, `lastRun`, `lastResult` or `pausedReason` — those are the
 * scheduler's own writes, carried across in `sanitizeTasks`. A client that could
 * set `nextAt = 0` would make its tasks permanently due and turn the 5-minute
 * tick into an unbounded spend loop.
 *
 * ── Failure is never silent ──────────────────────────────────────────────────
 * A KV outage returns 503, never an empty schedule. The panel is required to
 * keep showing the local list on a 503: rendering "no scheduled tasks" during a
 * throttle is how a user re-creates tasks that already exist and gets billed
 * twice for them.
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { readSession } from "@/lib/session";
import {
  readOwnerTasks,
  putSchedule,
  unenroll,
  sanitizeTasks,
  MAX_TASKS_PER_WALLET,
  type ScheduledTask,
} from "@/lib/scheduled-tasks";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Resolve the caller, or the response to return instead. Three-way, on purpose. */
async function requireWallet(req: NextRequest): Promise<{ wallet: string } | { res: NextResponse }> {
  const session = await readSession(req);
  if (session.status === "unavailable") {
    return { res: NextResponse.json(
      { error: "Could not verify session — store unavailable. Your tasks were not changed." },
      { status: 503, headers: NO_STORE },
    ) };
  }
  if (session.status === "anonymous") {
    return { res: NextResponse.json(
      { error: "Sign in with your wallet to run tasks in the background." },
      { status: 401, headers: NO_STORE },
    ) };
  }
  return { wallet: session.wallet };
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireWallet(req);
  if ("res" in auth) return auth.res;

  const read = await readOwnerTasks(auth.wallet);

  if (read.status === "unavailable") {
    return NextResponse.json(
      { error: "Schedule unavailable — showing your local copy.", detail: read.message },
      { status: 503, headers: NO_STORE },
    );
  }
  if (read.status === "empty") {
    // A genuine "you have never enabled background runs". Distinct from the 503
    // above, and the client IS allowed to act on it.
    return NextResponse.json({ status: "empty", tasks: [] }, { headers: NO_STORE });
  }
  return NextResponse.json(
    { status: "found", updatedAt: read.record.updatedAt, tasks: read.record.tasks },
    { headers: NO_STORE },
  );
}

// ─── PUT ─────────────────────────────────────────────────────────────────────

export async function PUT(req: NextRequest) {
  const auth = await requireWallet(req);
  if ("res" in auth) return auth.res;

  // Keyed on the authenticated wallet, not the IP: one busy tab must not
  // rate-limit a different user behind the same NAT.
  const rl = await rateLimit(auth.wallet, "hub"); // 20/min
  if (!rl.success) {
    return NextResponse.json({ error: "Saving too frequently — slow down." }, { status: 429, headers: NO_STORE });
  }

  let body: { tasks?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  if (!Array.isArray(body?.tasks)) {
    return NextResponse.json({ error: "`tasks` must be an array." }, { status: 400, headers: NO_STORE });
  }

  // Read BEFORE writing so run history survives an edit. Without this, renaming
  // a task would erase its last result — and on an outage we would write the
  // client's list with no history at all, so a 503 here is a refusal, not a
  // best-effort save.
  const existing = await readOwnerTasks(auth.wallet);
  if (existing.status === "unavailable") {
    return NextResponse.json(
      { error: "Could not read your current schedule — nothing was saved.", detail: existing.message },
      { status: 503, headers: NO_STORE },
    );
  }
  const previous: ScheduledTask[] = existing.status === "found" ? existing.record.tasks : [];

  const tasks = sanitizeTasks(body.tasks, previous);
  const dropped = body.tasks.length - tasks.length;

  try {
    await putSchedule(auth.wallet, tasks);
  } catch (e) {
    return NextResponse.json(
      { error: "Save failed — nothing was changed.", detail: (e as Error).message },
      { status: 503, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    {
      status: "ok",
      tasks,
      // Reported rather than swallowed: a client whose eleventh task was capped
      // away should find out, not discover it never ran.
      dropped: dropped > 0 ? dropped : 0,
      limit:   MAX_TASKS_PER_WALLET,
    },
    { headers: NO_STORE },
  );
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

/**
 * Removes the SERVER copy only. The browser keeps its tasks and can still run
 * them on open, exactly as turning off workspace sync keeps your conversations.
 * Nothing a user switches off should cost them data.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireWallet(req);
  if ("res" in auth) return auth.res;

  await unenroll(auth.wallet);
  return NextResponse.json({ status: "deleted" }, { headers: NO_STORE });
}
