/**
 * Blue Agent — Waitlist capture.
 *
 * POST /api/waitlist  { email, ref? }  → stores the email in a KV set (deduped)
 *   plus a small per-email metadata record (join time + optional ?ref source).
 * GET  /api/waitlist                    → { count } (non-PII, for social proof/admin).
 *
 * This is the data half of the env-flagged /app waitlist gate (see middleware.ts,
 * `appWaitlistGate`). It has NO payment path and NO email send — it only records
 * intent. When KV creds are absent (local dev) `@/lib/kv` degrades to an
 * in-memory Map, so the form still works end-to-end on localhost.
 */
import { NextRequest, NextResponse } from "next/server";
import { kvSAdd, kvSMembers, kvSet, kvSetNX } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SET_KEY = "waitlist:emails";

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  return (xff ? xff.split(",")[0].trim() : "") || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: NextRequest) {
  let body: { email?: string; ref?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  // Light per-IP throttle: 1 submit / 10s (NX = atomic; miss = allowed). Skipped
  // when the IP is unknown (e.g. localhost with no x-forwarded-for) so local
  // testing isn't rate-limited.
  const ip = clientIp(req);
  if (ip !== "unknown") {
    const ok = await kvSetNX(`waitlist:rl:${ip}`, "1", 10);
    if (!ok) {
      return NextResponse.json({ error: "Slow down — try again in a moment." }, { status: 429 });
    }
  }

  const ref = typeof body.ref === "string" && body.ref ? body.ref.slice(0, 64) : null;
  await kvSAdd(SET_KEY, email);
  await kvSet(`waitlist:meta:${email}`, { email, ts: Date.now(), ref });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  const members = await kvSMembers(SET_KEY);
  return NextResponse.json({ count: members.length });
}
