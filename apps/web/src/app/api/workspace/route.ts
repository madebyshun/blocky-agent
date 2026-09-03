/**
 * /api/workspace — the durable mirror of a user's Blue Chat state.
 *
 * GET    → read this wallet's workspace
 * PUT    → replace it
 * DELETE → stop syncing and remove the server copy
 *
 * ── The wallet comes from the session cookie. Always. ────────────────────────
 * There is no `?wallet=` and no `address` field in the body. That is the whole
 * reason `lib/session.ts` exists: the last per-wallet CRUD in this repo took
 * its wallet from the URL with no auth at all, which meant anyone could read or
 * overwrite anyone's record by typing a different address. It was retired
 * (#167, PR #367) rather than patched. This route is its authenticated
 * replacement, and it must not reintroduce the hole in a new shape.
 *
 * ── Failure must never be silent here ────────────────────────────────────────
 * The client mirrors localStorage → server and hydrates server → localStorage.
 * If a KV outage rendered as "empty workspace", hydration would blank a user's
 * conversation list and the next mirror would persist that blank. So both the
 * session read and the workspace read surface `unavailable` as a 503, and the
 * client is required to leave localStorage untouched when it sees one.
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import { readSession } from "@/lib/session";
import {
  readWorkspace,
  writeWorkspace,
  deleteWorkspace,
  sanitizeSections,
  MAX_WORKSPACE_BYTES,
} from "@/lib/workspace";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Resolve the caller, or the response that should be returned instead.
 * Three-way, for the reason in the file header.
 */
async function requireWallet(req: NextRequest): Promise<{ wallet: string } | { res: NextResponse }> {
  const session = await readSession(req);
  if (session.status === "unavailable") {
    return { res: NextResponse.json(
      { error: "Could not verify session — store unavailable. Your local data was not changed." },
      { status: 503, headers: NO_STORE },
    ) };
  }
  if (session.status === "anonymous") {
    return { res: NextResponse.json(
      { error: "Not signed in. Sign in with your wallet to sync." },
      { status: 401, headers: NO_STORE },
    ) };
  }
  return { wallet: session.wallet };
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireWallet(req);
  if ("res" in auth) return auth.res;

  const ws = await readWorkspace(auth.wallet);

  if (ws.status === "unavailable") {
    return NextResponse.json(
      { error: "Workspace unavailable — do not overwrite local data.", detail: ws.message },
      { status: 503, headers: NO_STORE },
    );
  }
  if (ws.status === "empty") {
    // A genuine "you have never synced". Distinct from the 503 above, and the
    // client is allowed to act on it (by uploading its local copy).
    return NextResponse.json({ status: "empty" }, { headers: NO_STORE });
  }
  return NextResponse.json(
    { status: "found", updatedAt: ws.workspace.updatedAt, sections: ws.workspace.sections },
    { headers: NO_STORE },
  );
}

// ─── PUT ─────────────────────────────────────────────────────────────────────

export async function PUT(req: NextRequest) {
  const auth = await requireWallet(req);
  if ("res" in auth) return auth.res;

  // Per-wallet, not per-IP: the identifier is the authenticated wallet, so one
  // noisy tab cannot rate-limit a different user behind the same NAT.
  const rl = await rateLimit(auth.wallet, "hub"); // 20/min
  if (!rl.success) {
    return NextResponse.json({ error: "Syncing too frequently — slow down." }, { status: 429, headers: NO_STORE });
  }

  let body: { sections?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }

  const sanitized = sanitizeSections(body?.sections);
  if (!sanitized) {
    return NextResponse.json({ error: "`sections` must be an object." }, { status: 400, headers: NO_STORE });
  }

  const result = await writeWorkspace(auth.wallet, sanitized.sections);

  if (result.status === "too-large") {
    return NextResponse.json(
      {
        error: `Workspace is ${Math.round(result.bytes / 1024)} KB, over the ${Math.round(MAX_WORKSPACE_BYTES / 1024)} KB sync limit. Nothing was saved — delete some conversations and try again.`,
        bytes: result.bytes,
        limit: MAX_WORKSPACE_BYTES,
      },
      { status: 413, headers: NO_STORE },
    );
  }
  if (result.status === "failed") {
    return NextResponse.json(
      { error: "Sync failed — nothing was saved. Your local data is unchanged.", detail: result.message },
      { status: 503, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    {
      status:    "ok",
      updatedAt: result.updatedAt,
      // The two lists describe THIS request, not the catalog. An earlier version
      // returned the static allowlist here under the name `allowed`, sitting next
      // to `rejected` — which reads as "these were stored" and would have told a
      // client its `connectors` were saved when they had been dropped.
      accepted:  Object.keys(sanitized.sections),
      // Reported, never silently swallowed — a client that tries to sync a
      // non-allowlisted section (credits, connectors) should find out.
      rejected:  sanitized.rejected,
    },
    { headers: NO_STORE },
  );
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

/**
 * Removes the SERVER copy only. The client never deletes a localStorage key as
 * part of syncing, so turning sync off can never cost the user their history.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireWallet(req);
  if ("res" in auth) return auth.res;

  await deleteWorkspace(auth.wallet);
  return NextResponse.json({ status: "deleted" }, { headers: NO_STORE });
}
