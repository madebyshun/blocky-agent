/**
 * Blue Hood — Telegram Bot API client (task 2.2).
 *
 * A DELIBERATELY-THIN wrapper over Telegram's `sendMessage`, shared by the
 * webhook route (command replies) and the alert-drain cron (DM fan-out). No
 * grammY, no long-polling — this bot runs in WEBHOOK mode on serverless, so all
 * it needs is: send one message, and report whether the send SUCCEEDED so the
 * drain can decide keep-in-pending-and-retry (temporary failure) vs. done.
 *
 * NON-CUSTODIAL: this file never touches a seed phrase, private key, or signs
 * anything — it moves text and nothing else. Acting on a signal always happens
 * in the user's own wallet in the web app (see the /start safety declaration).
 *
 * TOKEN OWNERSHIP: `TELEGRAM_BOT_TOKEN` now has exactly one claimant. Until
 * 2026-08-31 the legacy Sentinel bot at /api/webhook/telegram bound the same
 * token, and since Telegram permits only ONE webhook URL per token, whichever
 * URL `setWebhook` last pointed at won — so this module's liveness depended on
 * a setting stored at Telegram, not in this repo. Sentinel is retired and that
 * route is deleted; the webhook points at /api/telegram/webhook and nothing
 * else can take it. To read (never guess) the current binding:
 * `npm run tg:set-webhook -- --info` — read-only, prints no secret.
 */

const API = "https://api.telegram.org";

/** Bot token — already provisioned on Vercel. Empty in local dev → sends no-op. */
export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
/** Public @username, normalized without a leading `@`. Powers t.me deep links. */
export const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "");

// ── Telegram update types (only the fields we read) ──────────────────────────

export interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}
export interface TgChat {
  id: number;
  type: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  date: number;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

// ── Send ─────────────────────────────────────────────────────────────────────

export interface SendResult {
  /** true only when Telegram accepted the send (HTTP 2xx). */
  ok: boolean;
  /** HTTP status, when we got a response at all. */
  status?: number;
  /** Telegram's error `description`, or a local reason (no token / timeout). */
  description?: string;
}

/**
 * Send one HTML message. NEVER throws — every failure path returns
 * `{ ok:false, description }` so callers (especially the fire-and-forget drain)
 * can branch on delivery WITHOUT a try/catch. For a private chat, `chatId` is
 * the user's Telegram id (`chat_id === tg_user_id`).
 *
 * Telegram's contract: HTTP 200 ⟺ `ok:true`; every error is a 4xx/5xx whose
 * JSON body carries a `description`. So `res.ok` is a reliable success signal
 * and we only parse the body on the error path (to surface the reason).
 */
export async function sendMessage(
  chatId: string | number,
  text: string,
  opts?: { disablePreview?: boolean },
): Promise<SendResult> {
  if (!BOT_TOKEN) return { ok: false, description: "TELEGRAM_BOT_TOKEN not set" };
  try {
    const res = await fetch(`${API}/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: opts?.disablePreview ?? true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      let description = `http_${res.status}`;
      try {
        const body = (await res.json()) as { description?: string };
        if (body?.description) description = body.description;
      } catch {
        /* non-JSON error body — keep http_<status> */
      }
      return { ok: false, status: res.status, description };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    // Network / timeout / abort — a TEMPORARY failure. The drain keeps the id
    // in pending and retries next cycle.
    return { ok: false, description: (e as Error).message };
  }
}

// ── HTML escape ──────────────────────────────────────────────────────────────

/** Escape dynamic text for parse_mode:"HTML". Only &,<,> are significant. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Deep links ───────────────────────────────────────────────────────────────

/**
 * A t.me deep link to THIS bot, optionally carrying a `?start=` payload. Used by
 * the WEB side to hand a user straight into the bot (e.g. a pre-filled /link
 * code). Falls back to a bare t.me link when the username env is unset.
 */
export function botDeepLink(startParam?: string): string {
  if (!BOT_USERNAME) return "https://t.me";
  const q = startParam ? `?start=${encodeURIComponent(startParam)}` : "";
  return `https://t.me/${BOT_USERNAME}${q}`;
}

/** Short display form of a wallet — `0x1234…abcd`. Never leaks the full address. */
export function shortAddr(address: string): string {
  const a = address.trim();
  return a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
