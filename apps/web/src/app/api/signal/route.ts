/**
 * Blue Agent — Signal Receiver
 * Any agent on Base can POST a signal here.
 * Blue Agent receives it, scores it, stores in KV, optionally acts on it.
 *
 * Referenced in:
 *   - /.well-known/agent.json
 *   - collab/INTEGRATE.md
 *   - collab/agent-discovery.json
 *
 * Signal schema follows collab/shared-schemas.yml
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet, kvMutate } from "@/lib/kv";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";

export const runtime = "nodejs";
// Vercel kills serverless functions at 60s by default — explicit budget so
// it fails loudly instead of silently 504-ing.
export const maxDuration = 15;

const KV_KEY_SIGNALS     = "incoming:signals:latest";
const KV_KEY_SIGNAL_LOG  = "incoming:signals:log";
const KV_TTL             = 60 * 60 * 24;      // 24h for latest
const KV_TTL_LOG         = 60 * 60 * 24 * 30; // 30 days for log

// ─── Types ────────────────────────────────────────────────────────────────────

interface IncomingSignal {
  id:          string;
  source:      string;       // agent name e.g. "aeon", "miroshark"
  type:        string;       // "trending" | "risk" | "opportunity" | "alert"
  data:        Record<string, unknown>;
  confidence:  number;       // 0.0 – 1.0
  timestamp:   string;
  // optional
  priority?:   "low" | "medium" | "high";
  chain_id?:   number;
  callback?:   string;       // URL to POST response back to
}

interface ProcessedSignal extends IncomingSignal {
  received_at:  string;
  score:        number;      // Blue Agent's own score 0-100
  actionable:   boolean;
  action_taken: string;
}

// ─── Score signal ─────────────────────────────────────────────────────────────

function scoreSignal(signal: IncomingSignal): number {
  let score = Math.round(signal.confidence * 100);

  // Boost for known trusted agents
  const trustedSources = ["aeon", "miroshark", "bankr"];
  if (trustedSources.includes(signal.source.toLowerCase())) score += 10;

  // Boost for high priority
  if (signal.priority === "high") score += 10;
  if (signal.priority === "medium") score += 5;

  // Boost for Base chain
  if (signal.chain_id === 8453) score += 5;

  // Risk signals get extra weight
  if (signal.type === "risk" || signal.type === "alert") score += 5;

  return Math.min(100, score);
}

// ─── Decide action ────────────────────────────────────────────────────────────

function decideAction(signal: IncomingSignal, score: number): string {
  if (score >= 80) {
    if (signal.type === "risk" || signal.type === "alert") return "queued:urgent-review";
    if (signal.type === "opportunity") return "queued:research-loop";
    return "queued:process";
  }
  if (score >= 50) return "logged:monitor";
  return "logged:low-confidence";
}

// ─── Route handlers ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Rate limit: 100 req/min per IP
  const { success } = await rateLimit(getIdentifier(req), "api");
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Partial<IncomingSignal>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate required fields
  const { id, source, type, data, confidence, timestamp } = body;
  if (!id || !source || !type || !data || confidence == null || !timestamp) {
    return NextResponse.json({
      error: "Missing required fields: id, source, type, data, confidence, timestamp",
      schema: "https://raw.githubusercontent.com/madebyshun/blue-agent/main/collab/shared-schemas.yml",
    }, { status: 400 });
  }

  if (confidence < 0 || confidence > 1) {
    return NextResponse.json({ error: "confidence must be 0.0–1.0" }, { status: 400 });
  }

  const signal = body as IncomingSignal;
  const score  = scoreSignal(signal);
  const action = decideAction(signal, score);

  const processed: ProcessedSignal = {
    ...signal,
    received_at:  new Date().toISOString(),
    score,
    actionable:   score >= 50,
    action_taken: action,
  };

  // Store latest signal per source
  await kvSet(`${KV_KEY_SIGNALS}:${source}`, processed, KV_TTL);

  // Append to signal log
  // #150 A-part2 — the read and the write hit the SAME key, so a throttled read
  // fell back to `[]` and the "append" overwrote the whole 100-entry log with a
  // single signal. This is the collab log other agents POST into; losing it is
  // invisible from the 200 the sender gets back.
  const logRes = await kvMutate<ProcessedSignal[]>(
    KV_KEY_SIGNAL_LOG,
    [],
    (log) => [processed, ...log].slice(0, 100),
    KV_TTL_LOG,
  );
  const logged = logRes === "ok";
  if (!logged) console.error(`[Signal] log NOT appended (${logRes}) — signal ${id} from ${source} is not in the log`);

  console.log(`[Signal] source=${source} type=${type} confidence=${confidence} score=${score} action=${action}`);

  return NextResponse.json({
    ok:           true,
    received:     { id, source, type, confidence },
    score,
    actionable:   processed.actionable,
    action:       action,
    timestamp:    processed.received_at,
    // The per-source snapshot above always lands; the shared log may not. Say so
    // rather than letting the sender infer "logged" from `ok: true`.
    logged,
  });
}

// GET — discovery + recent signals (public)
export async function GET(req: NextRequest) {
  const source = req.nextUrl.searchParams.get("source");

  if (source) {
    const signal = await kvGet<ProcessedSignal>(`${KV_KEY_SIGNALS}:${source}`);
    return NextResponse.json({ source, signal });
  }

  const log = await kvGet<ProcessedSignal[]>(KV_KEY_SIGNAL_LOG) ?? [];

  return NextResponse.json({
    endpoint:    "Blue Agent Signal Receiver",
    description: "POST a signal to trigger Blue Agent intelligence loop",
    method:      "POST",
    schema:      "https://raw.githubusercontent.com/madebyshun/blue-agent/main/collab/shared-schemas.yml",
    example: {
      id:         "sig_youragent_001",
      source:     "your-agent-name",
      type:       "opportunity",
      data:       { subject: "...", context: "..." },
      confidence: 0.85,
      timestamp:  new Date().toISOString(),
    },
    recent_count: log.length,
    recent:       log.slice(0, 5),
  });
}
