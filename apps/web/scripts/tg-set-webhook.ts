/**
 * Blue Hood — point the Telegram webhook at THIS bot (task 2.2).
 *
 * The Blue Hood bot (/api/telegram/webhook) runs in WEBHOOK mode on serverless
 * — Telegram must be told, once, to POST every update to our route WITH a
 * secret_token it will then echo back in the `X-Telegram-Bot-Api-Secret-Token`
 * header on every request. Our route rejects any request missing that header
 * (401), so this script is what actually turns the bot on.
 *
 * ⚠ COLLISION — read before running:
 *   The legacy Sentinel bot (/api/webhook/telegram) binds the SAME
 *   TELEGRAM_BOT_TOKEN. Telegram allows exactly ONE active webhook URL per
 *   token, so pointing it HERE takes Sentinel's Telegram commands OFFLINE
 *   (Sentinel's cron alerts are unaffected — they push out, they don't receive).
 *   This is reversible: re-run against the old URL to hand the token back.
 *
 * SECURITY: this script never prints the bot token or the webhook secret. The
 * token lives only inside the api.telegram.org URL path (masked in every log);
 * the secret is sent in the POST body and only its length is echoed.
 *
 * Usage (from apps/web):
 *   npm run tg:set-webhook            # set → prod /api/telegram/webhook
 *   npm run tg:set-webhook -- --info  # read current webhook (no writes, no secret needed)
 *   npm run tg:set-webhook -- --drop  # set + drop the pending-update backlog (recommended on the FIRST switch from Sentinel)
 *   npm run tg:set-webhook -- --delete# remove the webhook entirely (both bots go dark)
 *   npm run tg:set-webhook -- --url=https://<preview>.vercel.app/api/telegram/webhook
 *
 * Env (auto-loaded from apps/web/.env.local):
 *   • TELEGRAM_BOT_TOKEN     — required for every mode
 *   • TELEGRAM_WEBHOOK_SECRET— required to SET (must match Vercel's value, or the
 *                              deployed route rejects every real Telegram update)
 *   • BH_WEBHOOK_URL         — optional default target (else prod URL below)
 */
import fs from "fs";
import path from "path";

// Load .env.local without pulling in dotenv (same pattern as hood-kick-crons).
(function loadEnvLocal() {
  try {
    const p = path.resolve(__dirname, "../.env.local");
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const key = s.slice(0, eq).trim();
      let value = s.slice(eq + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* keep going */ }
})();

const DEFAULT_URL = "https://blueagent.dev/api/telegram/webhook";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const urlArg = argv.find((a) => a.startsWith("--url="))?.slice("--url=".length);
const TARGET = (urlArg || process.env.BH_WEBHOOK_URL || DEFAULT_URL).trim();

const MODE: "info" | "delete" | "set" = has("--info")
  ? "info"
  : has("--delete")
    ? "delete"
    : "set";

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN missing from apps/web/.env.local — cannot talk to Telegram.");
  process.exit(2);
}

/** api.telegram.org base — carries the secret token in its path, so NEVER log it raw. */
const API = `https://api.telegram.org/bot${TOKEN}`;
/** The only safe-to-log identity: the bot id is the public number before the ':' — the hash after it is the secret half we never print. */
const MASKED = `bot${TOKEN.split(":")[0]}:•••`;

async function tg(method: string, body?: Record<string, unknown>) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
    error_code?: number;
  };
  return { httpOk: res.ok, ...json };
}

async function main() {
  console.log(`Bot:    ${MASKED}`);
  console.log(`API:    https://api.telegram.org/${MASKED}/<method>\n`);

  if (MODE === "info") {
    const r = await tg("getWebhookInfo");
    if (!r.ok) {
      console.error(`✗ getWebhookInfo failed: ${r.description ?? "unknown"}`);
      process.exit(1);
    }
    const info = r.result as {
      url?: string;
      pending_update_count?: number;
      last_error_date?: number;
      last_error_message?: string;
      has_custom_certificate?: boolean;
      allowed_updates?: string[];
    };
    console.log("Current webhook:");
    console.log(`  url                  : ${info.url || "(none set)"}`);
    console.log(`  pending_update_count : ${info.pending_update_count ?? 0}`);
    console.log(`  allowed_updates      : ${info.allowed_updates?.join(", ") || "(all)"}`);
    if (info.last_error_message) {
      const when = info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : "?";
      console.log(`  last_error           : ${info.last_error_message} @ ${when}`);
    }
    // Which bot owns the token right now — purely informational.
    if (info.url?.includes("/api/telegram/webhook")) console.log("\n→ Blue Hood is currently live on this token.");
    else if (info.url?.includes("/api/webhook/telegram")) console.log("\n→ Legacy Sentinel is currently live on this token.");
    else if (info.url) console.log("\n→ Some other URL owns this token.");
    else console.log("\n→ No webhook set — the bot receives nothing.");
    process.exit(0);
  }

  if (MODE === "delete") {
    const r = await tg("deleteWebhook", { drop_pending_updates: has("--drop") });
    if (r.ok) {
      console.log("✓ Webhook deleted — the bot now receives no updates (both routes dark).");
      process.exit(0);
    }
    console.error(`✗ deleteWebhook failed: ${r.description ?? "unknown"}`);
    process.exit(1);
  }

  // MODE === "set"
  if (!SECRET) {
    console.error(
      "TELEGRAM_WEBHOOK_SECRET missing from apps/web/.env.local.\n" +
        "  Mint one (1-256 chars, only A-Z a-z 0-9 _ -), add it to BOTH .env.local AND\n" +
        "  Vercel env (Production) for blueagent-web-new, redeploy, THEN run this. Without a\n" +
        "  matching secret on the server, the deployed route 401s every real Telegram update.",
    );
    process.exit(2);
  }
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(SECRET)) {
    console.error("TELEGRAM_WEBHOOK_SECRET has characters Telegram won't accept — allowed: A-Z a-z 0-9 _ - (1-256).");
    process.exit(2);
  }
  if (!/^https:\/\//.test(TARGET)) {
    console.error(`Refusing to set a non-HTTPS webhook URL: ${TARGET}`);
    process.exit(2);
  }

  console.log(`Setting webhook → ${TARGET}`);
  console.log(`  secret_token   : set (${SECRET.length} chars, value hidden)`);
  console.log(`  allowed_updates: ["message"]`);
  console.log(`  drop_pending   : ${has("--drop")}`);
  if (TARGET.includes("/api/telegram/webhook")) {
    console.log("  ⚠ this takes the legacy Sentinel bot's Telegram commands offline (reversible).");
  }
  console.log("");

  const r = await tg("setWebhook", {
    url: TARGET,
    secret_token: SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: has("--drop"),
  });
  if (r.ok) {
    console.log(`✓ Webhook set. Telegram will now POST updates to ${TARGET}`);
    console.log("  Verify: npm run tg:set-webhook -- --info   (then DM the bot /start)");
    process.exit(0);
  }
  console.error(`✗ setWebhook failed (${r.error_code ?? "?"}): ${r.description ?? "unknown"}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
