/**
 * Blue Agent — Research Loop
 *
 * Cron: every 6 hours (0 0,6,12,18 * * *)
 * Autonomous research loop for Base builders.
 *
 * Different from Daily Brief:
 * - Has memory (reads previous signals from KV)
 * - Generates typed signals with confidence scores
 * - Loop: each run's output feeds next run as context
 * - Pushes actionable builder intelligence, not market news
 *
 * Signal types:
 *   🔨 Build Opportunity — what to build right now
 *   📡 Ecosystem Shift   — narrative changing, builders should pivot
 *   🛡️ Risk Alert        — security / rug / exploit pattern trending
 *   💰 Grant Signal      — funding opportunity open
 *   🤝 Collab Signal     — two builders / protocols should connect
 */

import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet, kvMutate } from "@/lib/kv";
import { setAeonOutput } from "@/app/api/_lib/aeon-kv";
import { callLLM as callSharedLLM } from "@/app/api/_lib/llm";

export const runtime = "nodejs";
export const maxDuration = 120;

// ─── Config ───────────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID ?? "";
const CRON_SECRET        = process.env.CRON_SECRET ?? "";

const KV_KEY_SIGNALS     = "research:signals:latest";
const KV_KEY_HISTORY     = "research:signals:history";
const KV_TTL_SIGNALS     = 60 * 60 * 7;   // 7 hours
const KV_TTL_HISTORY     = 60 * 60 * 24 * 14; // 14 days

// ─── Types ────────────────────────────────────────────────────────────────────

type SignalType = "build" | "shift" | "risk" | "grant" | "collab";

interface Signal {
  type:        SignalType;
  title:       string;
  body:        string;
  action:      string;   // specific next step
  confidence:  number;   // 0-100
  timestamp:   string;
}

interface ResearchOutput {
  signals:     Signal[];
  summary:     string;   // 1-line brief for Daily Brief teaser
  runAt:       string;
  loopContext: string;   // what changed vs last run
}

// ─── KV memory helpers ────────────────────────────────────────────────────────

async function loadPreviousSignals(): Promise<Signal[]> {
  const data = await kvGet<Signal[]>(KV_KEY_SIGNALS);
  return data ?? [];
}

/**
 * Returns true when the rolling history was appended to, false when the history
 * read failed and the append was skipped.
 *
 * The KV_KEY_SIGNALS write is a plain overwrite — `signals` is produced whole by
 * runResearch and never merged with what was read — so it stays a kvSet.
 * The history write is the destructive one: #150 A-part2 — it read
 * KV_KEY_HISTORY and wrote back to the SAME key, so a throttled read yielded
 * `[]` and the "append" replaced 50 accumulated signals with just this run's.
 * The history is what makes the loop a loop; silently truncating it to one run
 * costs weeks of context and looks exactly like a normal run in the logs.
 */
async function saveSignals(signals: Signal[]): Promise<boolean> {
  await kvSet(KV_KEY_SIGNALS, signals, KV_TTL_SIGNALS);

  // Append to rolling history (last 50 signals)
  const res = await kvMutate<Signal[]>(
    KV_KEY_HISTORY,
    [],
    (history) => [...signals, ...history].slice(0, 50),
    KV_TTL_HISTORY,
  );
  return res === "ok";
}

// ─── LLM call ────────────────────────────────────────────────────────────────
// Routes through the shared callLLM (Virtuals). The old Bankr-first /
// Anthropic-fallback path was dead: llm.bankr.bot was 403-banned 2026-07-20 and
// the Anthropic direct key is usually out of credit. Local signature kept so
// the call sites below are unchanged.

async function callLLM(system: string, prompt: string): Promise<string> {
  return (await callSharedLLM({
    system,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 1500,
  })).text;
}

// ─── Research prompt ──────────────────────────────────────────────────────────

async function runResearch(previousSignals: Signal[]): Promise<ResearchOutput> {
  const now     = new Date().toISOString();
  const prevCtx = previousSignals.length > 0
    ? `Previous signals (last run):\n${previousSignals.map(s =>
        `- [${s.type}] ${s.title} (confidence: ${s.confidence})`
      ).join("\n")}`
    : "No previous signals — this is the first run.";

  const system = `You are Blue Agent Research Loop — an autonomous intelligence engine for Base builders.
You generate actionable builder signals, not market news.
Your audience: founders, developers, and builders on Base.
You have memory of previous signals and look for what changed.
Always respond with valid JSON only.`;

  const prompt = `Run the Blue Agent Research Loop for ${now}.

${prevCtx}

Generate 3-5 high-confidence builder intelligence signals for Base.

Signal types:
- "build": a specific thing worth building right now on Base (gap in market, new primitive, unmet demand)
- "shift": a narrative or ecosystem shift builders should respond to
- "risk": a security pattern, exploit trend, or protocol risk worth flagging
- "grant": an open funding opportunity (Base Grants, Coinbase, ecosystem funds)
- "collab": two protocols/builders that should connect or integrate

For each signal:
- title: short punchy headline (max 10 words)
- body: 2-3 sentences of context. Specific, not generic.
- action: exact next step for a Base builder ("Run blue build...", "Apply at...", "Audit your...")
- confidence: 0-100 based on how actionable and timely this is
- type: one of build|shift|risk|grant|collab

Also write:
- summary: 1 punchy sentence summarizing today's research (used in Daily Brief teaser)
- loopContext: 1 sentence on what changed vs previous run (or "First run" if no history)

Return ONLY valid JSON:
{
  "signals": [
    {
      "type": "build",
      "title": "...",
      "body": "...",
      "action": "...",
      "confidence": 85
    }
  ],
  "summary": "...",
  "loopContext": "..."
}`;

  const raw = await callLLM(system, prompt);

  try {
    let clean = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const oi = clean.indexOf("{"), oj = clean.lastIndexOf("}");
    if (oi >= 0 && oj > oi) clean = clean.slice(oi, oj + 1);
    const parsed = JSON.parse(clean) as Omit<ResearchOutput, "runAt">;
    return {
      ...parsed,
      signals: (Array.isArray(parsed.signals) ? parsed.signals : []).map(s => ({ ...s, timestamp: now })),
      runAt: now,
    };
  } catch {
    // Fallback if JSON parse fails
    return {
      signals: [{
        type: "shift",
        title: "Research loop running — Bankr LLM warming up",
        body: "Blue Agent Research Loop is active. Signals will populate once LLM is available.",
        action: "Check back in 6 hours for the next research cycle.",
        confidence: 50,
        timestamp: now,
      }],
      summary: "Research loop active — signals incoming.",
      loopContext: "First run or LLM unavailable.",
      runAt: now,
    };
  }
}

// ─── Telegram formatter ───────────────────────────────────────────────────────

const SIGNAL_EMOJI: Record<SignalType, string> = {
  build:  "🔨",
  shift:  "📡",
  risk:   "🛡️",
  grant:  "💰",
  collab: "🤝",
};

const SIGNAL_LABEL: Record<SignalType, string> = {
  build:  "Build Opportunity",
  shift:  "Ecosystem Shift",
  risk:   "Risk Alert",
  grant:  "Grant Signal",
  collab: "Collab Signal",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTelegram(output: ResearchOutput): string {
  const time = new Date(output.runAt).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });

  const lines: string[] = [];
  lines.push(`🔵 <b>Blue Agent — Research Loop</b>`);
  lines.push(`🕐 ${time} UTC`);
  if (output.loopContext && output.loopContext !== "First run") {
    lines.push(`↻ <i>${esc(output.loopContext)}</i>`);
  }
  lines.push(``);

  // Top signals (max 3 in Telegram)
  const topSignals = [...output.signals]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  for (const signal of topSignals) {
    const emoji = SIGNAL_EMOJI[signal.type];
    const label = SIGNAL_LABEL[signal.type];
    lines.push(`${emoji} <b>${esc(label)}</b> <code>[${signal.confidence}%]</code>`);
    lines.push(`<b>${esc(signal.title)}</b>`);
    lines.push(esc(signal.body));
    lines.push(`→ <i>${esc(signal.action)}</i>`);
    lines.push(``);
  }

  lines.push(`—`);
  lines.push(`<a href="https://blueagent.dev">blueagent.dev</a> · Blue Agent`);

  return lines.join("\n");
}

// ─── Delivery ─────────────────────────────────────────────────────────────────

async function sendTelegram(message: string): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text:       message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram error: ${res.status} — ${err}`);
  }
}

// ─── Mock output ─────────────────────────────────────────────────────────────

const MOCK_OUTPUT: ResearchOutput = {
  runAt: new Date().toISOString(),
  loopContext: "AI agent + DeFi composability gaining momentum vs last run",
  summary: "Prime window for ERC-4337 + Uniswap v4 hook compositions on Base — demand unmet.",
  signals: [
    {
      type: "build", timestamp: new Date().toISOString(),
      title: "ERC-4337 + v4 hook limit order — no good impl on Base",
      body: "Three Base DeFi protocols are actively looking for a smart wallet-native limit order hook for Uniswap v4. None of the existing implementations handle 4337 session keys properly. This is a 2-week build with clear demand.",
      action: "Run: blue build → 'ERC-4337 smart wallet limit order hook for Uniswap v4 on Base'",
      confidence: 91,
    },
    {
      type: "grant", timestamp: new Date().toISOString(),
      title: "Base Ecosystem Fund Round 4 — closes in 9 days",
      body: "Coinbase's Base Ecosystem Fund is accepting applications for AI agent infrastructure, consumer apps, and DeFi primitives. $50k–$500k grants. Previous round filled in 11 days.",
      action: "Apply at base.org/grants — focus pitch on AI agent utility or smart wallet UX",
      confidence: 88,
    },
    {
      type: "shift", timestamp: new Date().toISOString(),
      title: "AI agent + onchain payments narrative peaking on CT",
      body: "x402-style machine payments and agent wallets are dominating Base builder discourse this week. Projects launching with AI + micropayments framing getting 3–5x more visibility than pure DeFi plays.",
      action: "Add x402 payment hooks to your next build — use blueagent.dev/hub → x402 Escrow Patterns tool",
      confidence: 79,
    },
  ],
};

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authHeader  = req.headers.get("authorization");
  const url         = new URL(req.url);
  const secretParam = url.searchParams.get("secret");
  const isMock      = url.searchParams.get("mock") === "1";

  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}` && secretParam !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const steps: string[] = [];

  try {
    let output: ResearchOutput;

    if (isMock) {
      output = MOCK_OUTPUT;
      steps.push("✓ mock output loaded");
    } else {
      // 1. Load memory from KV
      const previousSignals = await loadPreviousSignals();
      steps.push(`✓ loaded ${previousSignals.length} previous signals from KV`);

      // 2. Run research loop
      output = await runResearch(previousSignals);
      steps.push(`✓ research complete — ${output.signals.length} signals generated`);

      // 3. Save to KV (powers the loop)
      const historyAppended = await saveSignals(output.signals);
      if (!historyAppended) {
        steps.push("⚠ rolling history NOT appended — KV read failed; this run's signals are not in the loop memory");
      }
      // Bridge: expose research signals to x402 tools via aeon:deep-research key.
      // These are MODEL-GENERATED leads (this cron calls the LLM), NOT measured
      // data — so we drop the numeric confidence (don't surface LLM self-scores
      // as if measured), flag grant leads as "verify independently", and tag the
      // KV entry source="model" so formatAeonForLLM labels it accordingly.
      try {
        const aeonText = [
          output.summary,
          "",
          ...output.signals.map(sig => {
            const tag = sig.type === "grant"
              ? "[GRANT — LLM-suggested, verify independently]"
              : `[${sig.type.toUpperCase()}]`;
            return `${tag} ${sig.title}: ${sig.body} → ACTION: ${sig.action}`;
          }),
          "",
          "(Model-generated leads, not measured data — verify each independently.)",
        ].join("\n");
        await setAeonOutput("deep-research", aeonText, undefined, "model");
      } catch (e) { console.error("[research-loop] aeon bridge failed:", e); }
      steps.push("✓ signals saved to KV");
    }

    // 4. Send Telegram
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const msg = formatTelegram(output);
      await sendTelegram(msg);
      steps.push("✓ telegram delivered");
    } else {
      steps.push("⚠ telegram skipped (missing env vars)");
    }

    return NextResponse.json({ ok: true, steps, output });

  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message, steps },
      { status: 500 }
    );
  }
}
