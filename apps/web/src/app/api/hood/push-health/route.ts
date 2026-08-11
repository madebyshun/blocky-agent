/**
 * Blue Hood — push health / VAPID key endpoint (T-D task A7).
 *
 * ONE server-side source of truth for the browser's VAPID public key.
 * The client (`EnableAlertsButton`) fetches from HERE — not from
 * `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, which would require the value to be
 * embedded at build time and creates the "user forgot to set the
 * public var" failure mode we hit twice.
 *
 * Also serves as an operator diagnostic:
 *   curl -s http://localhost:3000/api/hood/push-health | jq
 *
 * Response shape:
 *   {
 *     ok: true,
 *     vapid_public:  boolean,   // is VAPID_PUBLIC_KEY set on the server?
 *     vapid_private: boolean,   // is VAPID_PRIVATE_KEY set?
 *     subject:       boolean,   // is VAPID_SUBJECT set (or defaulted)?
 *     public_key:    string|null  // safe to expose — this is the PUBLIC half.
 *   }
 *
 * When public_key is null, the client renders `push setup failed ·
 * fetch-vapid-key` with the shipped diagnostic message instead of
 * hanging forever.
 */
import { NextResponse } from "next/server";
import { publicVapidKey } from "@/lib/blue-hood/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const pub = process.env.VAPID_PUBLIC_KEY ?? "";
  const priv = process.env.VAPID_PRIVATE_KEY ?? "";
  const subj = process.env.VAPID_SUBJECT ?? "";
  const key = publicVapidKey();
  return NextResponse.json(
    {
      ok: true,
      vapid_public: !!pub,
      vapid_private: !!priv,
      subject: !!subj,
      // Public key is safe to expose — that's literally its role.
      public_key: key,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
