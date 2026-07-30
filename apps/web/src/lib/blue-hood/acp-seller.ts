/**
 * Blue Hood — ACP v2 SELLER adapter (task 2.3, Offering #1: execution-plan).
 *
 * This is the ARCHITECTURE-DEPENDENT half of the paid offering — the piece that
 * actually talks to Virtuals ACP. It drives the maintained event SDK
 * (`@virtuals-protocol/acp-node-v2`) from a Vercel CRON POLL rather than a
 * persistent listener (the host decision for v1: no always-on infra). Each poll:
 *
 *   create adapter → agent.start() (hydrates every active job) → act on our
 *   provider jobs by status → agent.stop().
 *
 * `AcpAgent.start()` awaits `getActiveJobs()` hydration, so `agent.sessions` is a
 * complete snapshot the moment it resolves — the SDK explicitly documents this
 * as the startup-reconcile pattern. A job funded during the ~2-min gap between
 * ticks is simply picked up on the next tick's hydration (the accepted
 * higher-latency trade-off of cron-poll vs. a live socket).
 *
 * ── Non-custodial / settlement boundary ──────────────────────────────────────
 * The seller only ever calls three JobSession actions:
 *   • setBudget — propose our fixed price on a new job,
 *   • submit    — deliver the execution plan,
 *   • reject    — decline a bad/unfulfillable job (refunds the buyer's escrow).
 * It NEVER calls complete() or fund(). Escrow release / the 80-20 split is done
 * by the ACP contract (attributed via `builderCode`), NOT here. None of these
 * actions move the agent's own funds or a user's funds — they are the seller-side
 * protocol calls that fulfil a paid job. Gas is sponsored by the smart-account.
 *
 * ── Anti-ungraduation (the existential rule) ─────────────────────────────────
 * 10 consecutive expirations auto-ungraduate the agent, so a HUNG job is the
 * worst outcome and a FAST reject is safe. Every branch here either acts or
 * rejects — never leaves a funded job hanging:
 *   • bad/unknown requirement  → reject immediately (reject-incomplete),
 *   • engine blind / slow      → reject "temporarily unavailable" (no charge),
 *   • internal deadline < SLA  → withDeadline() forces a decision,
 *   • exactly-once submit      → acquireSubmitLock so a retrying tick never
 *                                double-delivers against the same escrow,
 *   • every job logged         → the KV ledger tracks the expire streak so we
 *                                see danger long before ACP's hard limit.
 *
 * ── Inert until configured ───────────────────────────────────────────────────
 * The heavy SDK (socket.io-client, @privy-io/node, @account-kit/infra,
 * @solana/kit) is loaded via a RUNTIME dynamic import reached ONLY after the env
 * gate passes. With no `ACP_WALLET_ADDRESS` / `ACP_WALLET_ID` /
 * `ACP_SIGNER_PRIVATE_KEY`, `runAcpPollCycle()` returns `{ configured:false }`
 * without ever importing the SDK — so shipping this is a no-op until the operator
 * registers the agent + sets env. The signer key is SECRET (operator holds it);
 * it is read from env and passed straight to the adapter — never logged.
 */
import {
  recordJobSeen,
  updateJobStatus,
  acquireSubmitLock,
} from "@/lib/blue-hood/acp-jobs";
import { computeExecutionPlan, type ExecPlan } from "@/lib/blue-hood/execution-plan";
import { findByTicker } from "@/lib/robinhood/rwa-registry";
// Type-only import — fully erased at compile time, so it never pulls the heavy
// SDK into the webpack bundle. Runtime values come from the dynamic import below.
import type { JobSession } from "@virtuals-protocol/acp-node-v2";

/** The module type, for fully-typed access to the dynamically-imported SDK. */
type AcpModule = typeof import("@virtuals-protocol/acp-node-v2");

/** Operator-provisioned config. All from env; the signer key is SECRET. */
interface AcpSellerConfig {
  walletAddress: `0x${string}`;
  walletId: string;
  signerPrivateKey: string;
  chainId: number;
  price: number;
  offeringName: string;
  builderCode?: string;
}

/** Per-tick outcome tally — what the cron reports (never contains secrets). */
export interface AcpPollTally {
  provider_sessions: number;
  budget_proposed: number;
  delivered: number; // deliverable submitted
  rejected_input: number; // bad shape / unknown ticker
  declined: number; // engine blind or deadline — no charge
  lock_skipped: number; // another tick owns the submit
  completed: number; // terminal completions reconciled
  expired: number; // terminal expirations reconciled
  noop: number; // awaiting counterparty (budget_set / submitted) or other terminal
  errors: number; // per-session crashes (kept — never aborts the batch)
}

export interface AcpPollResult extends Partial<AcpPollTally> {
  ok: boolean;
  configured: boolean;
  skipped?: string;
  error?: string;
  duration_ms: number;
}

/** Compute must return well within the ACP SLA — force a decision by here. */
const INTERNAL_DEADLINE_MS = 12_000;
/** Bound the connect+hydrate so a slow stream can't eat the whole cron budget. */
const START_DEADLINE_MS = 30_000;

/**
 * Read config from env. Returns null (→ inert) unless ALL THREE required secrets
 * are present. Cheap + SDK-free, so the route can gate on it without loading the
 * heavy package.
 */
function readConfig(): AcpSellerConfig | null {
  const walletAddress = process.env.ACP_WALLET_ADDRESS?.trim();
  const walletId = process.env.ACP_WALLET_ID?.trim();
  const signerPrivateKey = process.env.ACP_SIGNER_PRIVATE_KEY?.trim();
  if (!walletAddress || !walletId || !signerPrivateKey) return null;

  const chainId = Number(process.env.ACP_CHAIN_ID ?? "8453") || 8453; // Base default
  const priceRaw = Number(process.env.ACP_OFFERING_PRICE_USDC ?? "0.5");
  const price = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : 0.5;
  const offeringName = process.env.ACP_OFFERING_NAME?.trim() || "execution-plan";
  const builderCode = process.env.ACP_BUILDER_CODE?.trim() || undefined;

  return {
    walletAddress: walletAddress as `0x${string}`,
    walletId,
    signerPrivateKey,
    chainId,
    price,
    offeringName,
    builderCode,
  };
}

/** True when the operator has wired the three required secrets. SDK-free. */
export function isAcpSellerConfigured(): boolean {
  return readConfig() !== null;
}

/** Race a promise against a timeout; resolves null on timeout (never rejects). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Lenient JSON parse — buyers may fence or wrap the requirement payload. */
function lenientJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Pull the `{ ticker, size_usd }` requirement from a session. Tries the job
 * description first (populated by hydration), then the latest requirement-shaped
 * message entry. Returns null when the payload is missing or malformed → the
 * caller reject-incompletes.
 */
function extractRequirement(session: JobSession): { ticker: string; size_usd: number } | null {
  const sources: string[] = [];
  const desc = session.job?.description;
  if (desc) sources.push(desc);
  for (let k = session.entries.length - 1; k >= 0; k--) {
    const e = session.entries[k];
    if (
      e.kind === "message" &&
      (e.contentType === "requirement" || e.contentType === "structured" || e.contentType === "text")
    ) {
      sources.push(e.content);
      break;
    }
  }
  for (const raw of sources) {
    const obj = lenientJson(raw);
    if (!obj) continue;
    const ticker = String(obj.ticker ?? obj.symbol ?? "").trim();
    const size = Number(obj.size_usd ?? obj.sizeUsd ?? obj.size);
    if (ticker && Number.isFinite(size) && size > 0) return { ticker, size_usd: size };
  }
  return null;
}

/** Gross escrow value that settled for a completed job (a real on-chain fact). */
function grossUsdcFromJob(session: JobSession): number | undefined {
  const amt = session.job?.budget?.amount;
  return typeof amt === "number" && Number.isFinite(amt) ? amt : undefined;
}

/** The paid deliverable: the execution plan wrapped with light provenance. */
function buildDeliverable(cfg: AcpSellerConfig, plan: ExecPlan): string {
  return JSON.stringify({
    offering: cfg.offeringName,
    version: "1.0",
    generated_at: new Date().toISOString(),
    plan,
  });
}

/**
 * Handle ONE provider session by its current status. Isolated per-session try/
 * catch at the call site guarantees a single bad job never aborts the batch.
 */
async function handleSession(
  session: JobSession,
  cfg: AcpSellerConfig,
  AssetToken: AcpModule["AssetToken"],
  tally: AcpPollTally,
): Promise<void> {
  const jobId = session.jobId;
  const chainId = session.chainId;
  const buyer = session.job?.clientAddress;
  const req = extractRequirement(session);

  // Guarantee a ledger record exists BEFORE any transition (idempotent upsert;
  // created_at is stamped once, status is preserved for existing records). This
  // makes terminal reconciliation below always land on a real record.
  await recordJobSeen({
    job_id: jobId,
    chain_id: chainId,
    offering: cfg.offeringName,
    buyer: buyer ?? undefined,
    ticker: req?.ticker,
    size_usd: req?.size_usd,
    price_usdc: cfg.price,
  });

  switch (session.status) {
    case "open": {
      // Reject-incomplete: never set a budget for a job we can't fulfil.
      if (!req) {
        await session.reject("invalid requirement: expected JSON { ticker, size_usd }");
        await updateJobStatus(jobId, "rejected", { error: "bad_requirement" });
        tally.rejected_input++;
        return;
      }
      if (!findByTicker(req.ticker)) {
        await session.reject(`unknown ticker "${req.ticker}" — not a Robinhood-Chain RWA token`);
        await updateJobStatus(jobId, "rejected", { error: "unknown_ticker" });
        tally.rejected_input++;
        return;
      }
      // Valid → propose our fixed price (USDC on the job's own chain).
      await session.setBudget(AssetToken.usdc(cfg.price, chainId));
      await updateJobStatus(jobId, "budget_set", { ticker: req.ticker, size_usd: req.size_usd });
      tally.budget_proposed++;
      return;
    }

    case "funded": {
      if (!req) {
        await session.reject("invalid requirement at funding: expected JSON { ticker, size_usd }");
        await updateJobStatus(jobId, "rejected", { error: "bad_requirement" });
        tally.rejected_input++;
        return;
      }
      // Exactly-once: only one tick may ever submit this job.
      const won = await acquireSubmitLock(jobId);
      if (!won) {
        tally.lock_skipped++;
        return;
      }
      await updateJobStatus(jobId, "funded");

      const plan = await withDeadline(
        computeExecutionPlan({ ticker: req.ticker, size_usd: req.size_usd }),
        INTERNAL_DEADLINE_MS,
      );
      if (!plan) {
        // Timed out — decline (refund), never hang past the SLA.
        await session.reject("temporarily unavailable — plan timed out, job declined (no charge)");
        await updateJobStatus(jobId, "rejected", { error: "deadline" });
        tally.declined++;
        return;
      }
      if (plan.ok) {
        await session.submit(buildDeliverable(cfg, plan));
        await updateJobStatus(jobId, "submitted", { ticker: plan.ticker, size_usd: plan.size_usd });
        tally.delivered++;
        return;
      }
      if (plan.kind === "decline") {
        // Engine blind (no readable market) — decline, no charge.
        await session.reject(`temporarily unavailable — ${plan.reason} (declined, no charge)`);
        await updateJobStatus(jobId, "rejected", { error: plan.error });
        tally.declined++;
        return;
      }
      // Late-caught bad input (e.g. unknown ticker that slipped past "open").
      await session.reject(`${plan.reason} ${plan.hint ?? ""}`.trim());
      await updateJobStatus(jobId, "rejected", { error: plan.error });
      tally.rejected_input++;
      return;
    }

    case "completed": {
      const usdc = grossUsdcFromJob(session);
      await updateJobStatus(jobId, "completed", usdc != null ? { usdc_collected: usdc } : {});
      tally.completed++;
      return;
    }

    case "expired": {
      await updateJobStatus(jobId, "expired");
      tally.expired++;
      return;
    }

    case "rejected": {
      await updateJobStatus(jobId, "rejected");
      tally.noop++;
      return;
    }

    default: {
      // budget_set (awaiting buyer funding) or submitted (awaiting evaluator) —
      // nothing for the seller to do this tick.
      tally.noop++;
      return;
    }
  }
}

/**
 * Run one ACP poll cycle. Total + safe: returns a result on every path, never
 * throws. Inert (`configured:false`) until the operator wires the env secrets.
 */
export async function runAcpPollCycle(): Promise<AcpPollResult> {
  const started = Date.now();
  const cfg = readConfig();
  if (!cfg) {
    return { ok: true, configured: false, skipped: "acp_not_configured", duration_ms: 0 };
  }

  const tally: AcpPollTally = {
    provider_sessions: 0,
    budget_proposed: 0,
    delivered: 0,
    rejected_input: 0,
    declined: 0,
    lock_skipped: 0,
    completed: 0,
    expired: 0,
    noop: 0,
    errors: 0,
  };

  let acp: AcpModule;
  try {
    // Reached ONLY when configured — an unconfigured deploy never loads the SDK.
    acp = await import("@virtuals-protocol/acp-node-v2");
  } catch (e) {
    console.warn(`[acp-poll] SDK import failed: ${(e as Error).message}`);
    return { ok: false, configured: true, error: "sdk_import_failed", duration_ms: Date.now() - started };
  }

  const { AcpAgent, PrivyAlchemyEvmProviderAdapter, AssetToken, getEvmChainByChainId } = acp;

  let agent: InstanceType<AcpModule["AcpAgent"]> | null = null;
  try {
    const chain = getEvmChainByChainId(cfg.chainId);
    const evmProvider = await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: cfg.walletAddress,
      walletId: cfg.walletId,
      signerPrivateKey: cfg.signerPrivateKey,
      chains: chain ? [chain] : undefined,
      builderCode: cfg.builderCode,
    });
    agent = await AcpAgent.create({ evmProvider });

    // Connect + hydrate active jobs, bounded so a slow stream can't wedge us.
    const connected = await withDeadline(agent.start().then(() => true), START_DEADLINE_MS);
    if (!connected) {
      console.warn("[acp-poll] start() timed out — leaving jobs for next tick");
      return { ok: false, configured: true, error: "start_timeout", duration_ms: Date.now() - started };
    }

    const providerSessions = agent.sessions.filter((s) => s.roles.includes("provider"));
    tally.provider_sessions = providerSessions.length;

    for (const session of providerSessions) {
      try {
        await handleSession(session, cfg, AssetToken, tally);
      } catch (e) {
        // Per-session backstop — a single job's failure must not stop the batch.
        console.warn(`[acp-poll] session ${session.jobId} failed: ${(e as Error).message}`);
        tally.errors++;
      }
    }
  } catch (e) {
    // Init/connect failure → offering is "temporarily unavailable" this tick;
    // jobs remain for the next one. Never throws out of the cron.
    console.warn(`[acp-poll] cycle init failed: ${(e as Error).message}`);
    return { ok: false, configured: true, error: "init_failed", ...tally, duration_ms: Date.now() - started };
  } finally {
    if (agent) await agent.stop().catch(() => {});
  }

  return { ok: true, configured: true, ...tally, duration_ms: Date.now() - started };
}
