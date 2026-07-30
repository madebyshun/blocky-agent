/**
 * Blue Hood — ACP job ledger (task 2.3, Offering #1).
 *
 * The KV-backed record of every Virtuals ACP job Blue Hood is hired for. This
 * module is the ARCHITECTURE-INDEPENDENT half of the paid offering: it does not
 * know or care whether the job lifecycle is driven by a persistent listener, a
 * cron-poll (our v1), or a webhook — it only records state transitions and
 * answers two questions the rest of the system needs:
 *
 *   • "Have we already fulfilled job X?"  → acquireSubmitLock / getJob
 *     Idempotency is EXISTENTIAL here: a double-submit against the same escrow
 *     could double-deliver or confuse the buyer. The lock is a single atomic
 *     kvSetNX — won by exactly one caller, ever.
 *
 *   • "What revenue have we provably earned, and are we near ungraduation?"
 *     → computeAcpRevenue. Completed-job count + USDC collected is the provable
 *     revenue Blue Agent lacked; the consecutive-expire streak is the EARLY
 *     WARNING that fires before ACP's 10-in-a-row auto-ungraduation.
 *
 * Non-custodial / trust: we store only public routing + economic facts (job id,
 * buyer address, ticker, size, budget, USDC amount). NEVER a key, signer, or
 * anything that could move funds. Escrow settlement is done by the ACP contract,
 * not here — this ledger only OBSERVES the outcome.
 *
 * Fault posture: every function degrades to a safe default on KV error (never
 * throws out). A ledger blip must never crash the poll cron or the public
 * revenue endpoint — a missed write simply re-reconciles next cycle.
 */
import {
  kvGet,
  kvSet,
  kvSetNX,
  kvSAdd,
  kvSMembers,
} from "@/lib/kv";
import {
  kvAcpJob,
  KV_ACP_JOB_INDEX,
  kvAcpSubmitLock,
  KV_ACP_TERMINAL_LOG,
  TTL_ACP_JOB,
  TTL_ACP_SUBMIT_LOCK,
  ACP_TERMINAL_LOG_MAX,
  ACP_JOB_INDEX_MAX,
  ACP_EXPIRE_STREAK_WARN,
  ACP_EXPIRE_STREAK_DANGER,
} from "@/lib/blue-hood/kv-keys";

/** Lifecycle states, mirroring the ACP JobSession status vocabulary. */
export type AcpJobStatus =
  | "seen" // discovered, not yet funded
  | "budget_set" // provider proposed a price
  | "funded" // buyer funded escrow — our cue to fulfil
  | "submitted" // deliverable sent, awaiting buyer/evaluator
  | "completed" // approved — revenue realised
  | "rejected" // evaluator rejected the deliverable
  | "expired"; // job timed out — the ungraduation-risk outcome

const TERMINAL: ReadonlySet<AcpJobStatus> = new Set(["completed", "rejected", "expired"]);

/** One job's durable record. Only public routing + economic facts — never a key. */
export interface AcpJobRecord {
  job_id: string;
  chain_id: number;
  offering: string; // e.g. "execution-plan"
  status: AcpJobStatus;
  buyer?: string; // buyer wallet address (public)
  ticker?: string; // parsed from the job requirement
  size_usd?: number; // parsed from the job requirement
  price_usdc?: number; // budget agreed for the job
  usdc_collected?: number; // amount actually received on completion
  error?: string; // last compute/submit error, if any
  created_at: string; // ISO — first seen
  updated_at: string; // ISO — last transition
}

/** Shape returned by the public revenue endpoint. All facts, no fabrication. */
export interface AcpRevenueSummary {
  offering: string;
  completed_jobs: number;
  usdc_collected: number;
  rejected_jobs: number;
  expired_jobs: number;
  in_flight_jobs: number; // seen/budget_set/funded/submitted (not yet terminal)
  total_jobs: number;
  expire_streak: number; // consecutive expirations at the tail of the terminal log
  expire_streak_warn_at: number;
  expire_streak_danger_at: number;
  near_ungraduation: boolean; // streak >= warn threshold — operator should look
  recent: Array<
    Pick<AcpJobRecord, "job_id" | "status" | "ticker" | "size_usd" | "usdc_collected" | "updated_at">
  >;
  as_of: string;
}

const now = () => new Date().toISOString();

/**
 * Upsert a job on first sight (or refresh routing facts). Idempotent: the index
 * is a SET so re-adding is a no-op, and created_at is only stamped once.
 */
export async function recordJobSeen(
  job: Pick<AcpJobRecord, "job_id" | "chain_id" | "offering"> &
    Partial<Pick<AcpJobRecord, "buyer" | "ticker" | "size_usd" | "price_usdc" | "status">>,
): Promise<AcpJobRecord> {
  const existing = await kvGet<AcpJobRecord>(kvAcpJob(job.job_id));
  const ts = now();
  const rec: AcpJobRecord = existing
    ? { ...existing, ...stripUndefined(job), updated_at: ts }
    : {
        job_id: job.job_id,
        chain_id: job.chain_id,
        offering: job.offering,
        status: job.status ?? "seen",
        buyer: job.buyer,
        ticker: job.ticker,
        size_usd: job.size_usd,
        price_usdc: job.price_usdc,
        created_at: ts,
        updated_at: ts,
      };
  await kvSet(kvAcpJob(job.job_id), rec, TTL_ACP_JOB);
  await kvSAdd(KV_ACP_JOB_INDEX, job.job_id);
  return rec;
}

/**
 * Transition a job to a new status, merging any economic facts learned. On a
 * TERMINAL transition we also append to the outcome log that drives the
 * consecutive-expire streak. Safe to call repeatedly with the same status —
 * the terminal log only gets an entry when the status actually CHANGES into a
 * terminal state (guarded by the prior record), so re-observing "expired"
 * twice never inflates the streak.
 */
export async function updateJobStatus(
  jobId: string,
  status: AcpJobStatus,
  patch: Partial<Pick<AcpJobRecord, "usdc_collected" | "price_usdc" | "ticker" | "size_usd" | "buyer" | "error">> = {},
): Promise<AcpJobRecord | null> {
  const existing = await kvGet<AcpJobRecord>(kvAcpJob(jobId));
  if (!existing) {
    // Never seen — nothing to transition. Caller should recordJobSeen first.
    return null;
  }
  const wasTerminal = TERMINAL.has(existing.status);
  const becomesTerminal = TERMINAL.has(status);
  const rec: AcpJobRecord = { ...existing, ...stripUndefined(patch), status, updated_at: now() };
  await kvSet(kvAcpJob(jobId), rec, TTL_ACP_JOB);
  // Only log the FIRST time a job crosses into a terminal state.
  if (becomesTerminal && !wasTerminal) {
    await pushTerminalOutcome(status);
  }
  return rec;
}

/**
 * Acquire the exclusive right to submit a deliverable for this job. Returns true
 * to EXACTLY ONE caller (atomic SET NX). Any concurrent/retrying tick gets false
 * and must NOT submit. This is the idempotency backbone of the seller adapter.
 */
export async function acquireSubmitLock(jobId: string): Promise<boolean> {
  return kvSetNX(kvAcpSubmitLock(jobId), now(), TTL_ACP_SUBMIT_LOCK);
}

/** Read one job record (or null). */
export async function getJob(jobId: string): Promise<AcpJobRecord | null> {
  return kvGet<AcpJobRecord>(kvAcpJob(jobId));
}

/**
 * Aggregate the ledger into the public revenue summary. Computed FROM the job
 * records (recomputable truth), not from counters that could drift. Bounded by
 * ACP_JOB_INDEX_MAX so a large keyspace can never blow up the request.
 */
export async function computeAcpRevenue(offering = "execution-plan"): Promise<AcpRevenueSummary> {
  const ids = (await kvSMembers(KV_ACP_JOB_INDEX)).slice(0, ACP_JOB_INDEX_MAX);
  const records = (await Promise.all(ids.map((id) => kvGet<AcpJobRecord>(kvAcpJob(id))))).filter(
    (r): r is AcpJobRecord => r !== null,
  );

  let completed = 0;
  let rejected = 0;
  let expired = 0;
  let inFlight = 0;
  let usdc = 0;
  for (const r of records) {
    switch (r.status) {
      case "completed":
        completed++;
        usdc += Number.isFinite(r.usdc_collected) ? (r.usdc_collected as number) : 0;
        break;
      case "rejected":
        rejected++;
        break;
      case "expired":
        expired++;
        break;
      default:
        inFlight++;
    }
  }

  const streak = await expireStreak();
  const recent = records
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 10)
    .map((r) => ({
      job_id: r.job_id,
      status: r.status,
      ticker: r.ticker,
      size_usd: r.size_usd,
      usdc_collected: r.usdc_collected,
      updated_at: r.updated_at,
    }));

  return {
    offering,
    completed_jobs: completed,
    usdc_collected: round2(usdc),
    rejected_jobs: rejected,
    expired_jobs: expired,
    in_flight_jobs: inFlight,
    total_jobs: records.length,
    expire_streak: streak,
    expire_streak_warn_at: ACP_EXPIRE_STREAK_WARN,
    expire_streak_danger_at: ACP_EXPIRE_STREAK_DANGER,
    near_ungraduation: streak >= ACP_EXPIRE_STREAK_WARN,
    recent,
    as_of: now(),
  };
}

/** Current consecutive-expire streak = leading run of "expired" in the log. */
export async function expireStreak(): Promise<number> {
  const log = (await kvGet<AcpJobStatus[]>(KV_ACP_TERMINAL_LOG)) ?? [];
  let n = 0;
  for (const outcome of log) {
    if (outcome === "expired") n++;
    else break;
  }
  return n;
}

// ── internals ────────────────────────────────────────────────────────────────

/** Prepend a terminal outcome, keeping the log capped + newest-first. */
async function pushTerminalOutcome(outcome: AcpJobStatus): Promise<void> {
  const log = (await kvGet<AcpJobStatus[]>(KV_ACP_TERMINAL_LOG)) ?? [];
  const next = [outcome, ...log].slice(0, ACP_TERMINAL_LOG_MAX);
  await kvSet(KV_ACP_TERMINAL_LOG, next);
}

/** Drop undefined keys so a partial patch never clobbers a known value with undefined. */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
