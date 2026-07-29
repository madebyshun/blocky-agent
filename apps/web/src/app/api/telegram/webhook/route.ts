/**
 * Blue Hood — Telegram webhook (task 2.2).
 * POST /api/telegram/webhook
 *
 * Webhook-mode bot (NOT long-polling — serverless). Telegram POSTs every update
 * here; we verify the secret, route four READ-ONLY commands, and reply. The bot
 * NEVER signs, trades, or touches a key — acting on a signal happens in the
 * user's own wallet in the web app (see /start's safety declaration).
 *
 * SECURITY: every request must carry `X-Telegram-Bot-Api-Secret-Token` equal to
 * `TELEGRAM_WEBHOOK_SECRET` (set on the webhook via setWebhook). A request
 * without it is rejected 401 — that's the only thing standing between this route
 * and the open internet.
 *
 * COLLISION: the legacy Sentinel bot at /api/webhook/telegram binds the SAME
 * bot token. Only one webhook URL is active per token, so this route goes live
 * only once the operator repoints setWebhook here (scripts/tg-set-webhook.ts).
 *
 * Commands (all read-only, no sign/trade):
 *   /start        — intro + hard safety declaration + Open-Blue-Hood link
 *   /link CODE    — bind this Telegram user ↔ the wallet that minted CODE (1.7)
 *   /drift TICKER — live oracle vs DEX drift from the latest snapshot (health-gated)
 *   /track        — public hit-rate, gated below the sample threshold (0.2)
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGetProbe } from "@/lib/kv";
import { sendMessage, esc, shortAddr, type TgUpdate, type TgUser } from "@/lib/telegram/bot";
import { consumeTgLinkCode, isValidTicker } from "@/lib/blue-hood/watchlist";
import { KV_SNAPSHOT_LATEST } from "@/lib/blue-hood/kv-keys";
import type { HoodSnapshot } from "@/lib/blue-hood/types";
import { readPublicArrows } from "@/lib/blue-hood/public-feed";
import { computeHitRate } from "@/lib/blue-hood/hit-rate-gate";
import { absoluteUrl } from "@/lib/site-url";

export const runtime = "nodejs";

// ── Secret gate ──────────────────────────────────────────────────────────────

/**
 * Verify Telegram's per-webhook secret header. When the env secret is unset we
 * allow only in non-production (local dev has no secret + no real webhook); in
 * production an unset secret means "refuse everything" rather than run open.
 */
function verifySecret(req: NextRequest): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("x-telegram-bot-api-secret-token") === secret;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function usd(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}
function usdCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
/** Format a real ISO timestamp (UTC) as New-York wall-clock — the market's tz. */
function nyTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return (
      new Date(iso).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/New_York",
      }) + " ET"
    );
  } catch {
    return iso;
  }
}

// ── Command handlers (each returns the reply text) ───────────────────────────

function handleStart(): string {
  const hood = absoluteUrl("/hood");
  return [
    `🎯 <b>Blue Hood</b>`,
    `Drift & arbitrage signals for tokenized stocks on Robinhood Chain — every signal graded in public, misses included.`,
    ``,
    `🔒 <b>Safety</b>`,
    `Blue Hood never asks for your seed phrase or private key, and never signs transactions here. To act on a signal, you sign in your own wallet in the app.`,
    ``,
    `<a href="${hood}">Open Blue Hood →</a>`,
    ``,
    `Watching tickers in the app? Send <code>/link CODE</code> to get alert DMs here — create your code in Blue Hood.`,
    ``,
    `<b>Commands</b>`,
    `• <code>/drift TICKER</code> — live oracle vs DEX drift`,
    `• <code>/track</code> — public hit-rate`,
    `• <code>/link CODE</code> — link your wallet for alerts`,
  ].join("\n");
}

async function handleLink(rest: string, from?: TgUser): Promise<string> {
  const code = (rest.trim().split(/\s+/)[0] ?? "").toUpperCase();
  if (!code) {
    return `Send the code from the app, e.g. <code>/link ABC123</code>. Create yours in Blue Hood.`;
  }
  if (!from?.id) {
    return `Couldn't read your Telegram id — please try again.`;
  }
  const res = await consumeTgLinkCode(code, from.id, from.username);
  if (!res.ok) {
    // Never reveal a wallet on failure — a bad/expired code was never bound to one.
    return `❌ ${esc(res.reason)}. Open Blue Hood, create a fresh code, then send <code>/link NEWCODE</code>.`;
  }
  return [
    `✅ Linked to <code>${esc(shortAddr(res.address))}</code>.`,
    `You'll get alert DMs here for the tickers you watch.`,
    ``,
    `Manage your watchlist in <a href="${absoluteUrl("/hood")}">Blue Hood</a>.`,
  ].join("\n");
}

async function handleDrift(rest: string): Promise<string> {
  const ticker = (rest.trim().split(/\s+/)[0] ?? "").toUpperCase();
  if (!ticker) {
    return `Send a ticker, e.g. <code>/drift NVDA</code>.`;
  }
  if (!isValidTicker(ticker)) {
    return `❓ <b>${esc(ticker)}</b> isn't a Robinhood Chain RWA ticker I track.`;
  }

  // HEALTH GATE: kvGetProbe distinguishes a KV THROW (engine blind →
  // observable:false) from a genuine miss (cold start) — the exact distinction
  // 1.3's health module makes, in ONE read. We never show stale/wrong numbers
  // off a KV we couldn't read.
  const probe = await kvGetProbe<HoodSnapshot>(KV_SNAPSHOT_LATEST);
  if (probe.status === "error") {
    return `⏳ Data temporarily unavailable for <b>${esc(ticker)}</b> — the engine can't be read right now. Try again shortly.`;
  }
  if (probe.status === "miss") {
    return `⏳ No snapshot yet — the engine is warming up. Try <b>${esc(ticker)}</b> again in a few minutes.`;
  }

  const snap = probe.value;
  const row = snap.tickers.find((t) => t.ticker.toUpperCase() === ticker);
  if (!row) {
    return `No live data for <b>${esc(ticker)}</b> in the latest cycle.`;
  }
  if (row.verdict === "ERROR" || row.no_data_reason || row.dex_usd == null) {
    const why =
      row.no_data_reason === "no_pool"
        ? "no DEX pool"
        : row.no_data_reason === "fetch_failed"
          ? "feed fetch failed"
          : row.error ?? "no DEX data";
    return `⚠️ No usable data for <b>${esc(ticker)}</b> right now (${esc(why)}).`;
  }

  return [
    `📊 <b>${esc(row.ticker)}</b> — ${esc(row.name)}`,
    ``,
    `Oracle: <b>${usd(row.oracle_usd)}</b>`,
    `DEX: <b>${usd(row.dex_usd)}</b>`,
    `Drift: <b>${pct(row.drift_pct)}</b> <i>(DEX vs oracle)</i>`,
    `Verdict: <b>${esc(row.verdict)}</b>`,
    `TVL: ${usdCompact(row.total_tvl_usd ?? row.tvl_usd)} <i>(all pools)</i>`,
    `Market: ${esc(row.market.session)}${row.market.is_open ? " · open" : " · closed"}`,
    ``,
    `<i>as of ${nyTime(snap.finished_at)}</i>`,
    `<a href="${absoluteUrl("/hood")}">Open in Blue Hood</a>`,
  ].join("\n");
}

async function handleTrack(): Promise<string> {
  const arrows = await readPublicArrows(100);
  const { hit_rate, per_type } = computeHitRate(arrows);

  if (!hit_rate.ready) {
    // NO fabricated pct below the sample threshold — that's the whole point of 0.2.
    return [
      `📈 <b>Blue Hood — Track Record</b>`,
      ``,
      `Warming up — <b>${hit_rate.sample}</b> graded so far.`,
      `Every signal is graded in public, misses included.`,
      hit_rate.needed ? `<i>${hit_rate.needed} graded needed before a headline %.</i>` : ``,
      ``,
      `<a href="${absoluteUrl("/hood")}">Open Blue Hood → see the receipts</a>`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const byType = (["drift", "arb", "flow"] as const)
    .map((t) => {
      const s = per_type[t];
      return s && s.ready && s.pct != null ? `${t} ${s.pct}%` : null;
    })
    .filter(Boolean)
    .join(" · ");

  return [
    `📈 <b>Blue Hood — Track Record</b>`,
    ``,
    `<b>${hit_rate.pct}% hit rate</b> (${hit_rate.sample} graded)`,
    byType ? `By type: ${byType}` : ``,
    ``,
    `<a href="${absoluteUrl("/hood")}">Open Blue Hood → full record</a>`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Route ────────────────────────────────────────────────────────────────────

/** GET is a deploy smoke-check only — reveals nothing, needs no secret. */
export async function GET() {
  return NextResponse.json({ ok: true, webhook: "blue-hood-telegram" });
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: true }); // ignore malformed — never make TG retry
  }

  try {
    const msg = update.message;
    if (!msg?.text) return NextResponse.json({ ok: true });

    const rawText = msg.text.trim();
    const rawCmd = rawText.split(/\s+/)[0] ?? "";
    const cmd = rawCmd.toLowerCase().split("@")[0]; // strip @botname in group chats
    const rest = rawText.slice(rawCmd.length).trim();

    let reply: string | null = null;
    switch (cmd) {
      case "/start":
        reply = handleStart();
        break;
      case "/link":
        reply = await handleLink(rest, msg.from);
        break;
      case "/drift":
        reply = await handleDrift(rest);
        break;
      case "/track":
        reply = await handleTrack();
        break;
      default:
        if (cmd.startsWith("/")) reply = `Unknown command. Send /start to see what I can do.`;
    }

    if (reply) {
      const sent = await sendMessage(msg.chat.id, reply);
      if (!sent.ok) {
        console.warn(`[tg-webhook] reply failed cmd=${cmd} chat=${msg.chat.id}: ${sent.description}`);
      }
    }
  } catch (e) {
    // Never 500 — Telegram would retry-storm on our own bug.
    console.error(`[tg-webhook] handler error: ${(e as Error).message}`);
  }

  return NextResponse.json({ ok: true });
}
